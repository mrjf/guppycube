import {
  ArrowDownToLine,
  Bell,
  Bot,
  Check,
  Clock3,
  Copy,
  Crown,
  Eye,
  EyeOff,
  GripVertical,
  HelpCircle,
  History,
  Layers3,
  LogOut,
  Palette,
  Plus,
  Redo2,
  RotateCcw,
  SlidersHorizontal,
  Sparkles,
  Undo2,
  Users,
  Wifi,
  WifiOff,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  CSSProperties,
  DragEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import { resolveWilcardAssignments, validateSet, validateTurn } from "../../shared/rules";
import { findLinkedRackTileIds, groupSortedRackTileIds, normalizeSetTileIds, sortTileIds } from "../../shared/sorting";
import type { TileSortMode } from "../../shared/sorting";
import { ASSIST_DEFINITIONS } from "../../shared/types";
import type { AssistId, ComputerStrategyId, GameEvent, GameSession, GameSet, PublicGameState } from "../../shared/types";
import { validators } from "../../validation";
import { addComputer, ApiRequestError, getGame, getPlayerLink, saveTurnDraft, setAssist, socketUrl, startGame, takeAction } from "../api";
import { createFeltLayout } from "../felt-layout";
import type { FeltLayout } from "../felt-layout";
import { mergeGameState } from "../game-state";
import {
  createRackLayout,
  MANUAL_RACK_SLOTS_PER_ROW,
  parseRackLayout,
  placeRackTilesAtSlot,
  rackSlotIndex,
  rackSlotRows,
  rackTileIds,
  reconcileRackLayout,
  removeRackTiles,
} from "../rack-layout";
import type { RackDropSide, RackLayout } from "../rack-layout";
import {
  COLOR_THEMES,
  colorThemeById,
  TILE_THEMES,
  tileThemeById,
  tileThemeIdFromLegacyTheme,
} from "../themes";
import { CatFaceIcon } from "./CatFaceIcon";
import { TileView } from "./TileView";

interface GameProps {
  session: GameSession;
  onExit: () => void;
  onSessionMissing: (roomCode: string) => void;
  onShowRules: () => void;
}

type MoveTarget =
  | { type: "rack"; slotIndex?: number; side?: RackDropSide }
  | { type: "new"; setId?: string }
  | { type: "set"; setId: string };

type DragItem =
  | { type: "tiles"; tileIds: string[] }
  | { type: "set"; setId: string };

interface TurnDraft {
  board: GameSet[];
  rackLayout: RackLayout;
}

const DRAG_ITEM_TYPE = "application/x-guppycube-item";
const RACK_HOLD_MS = 500;
const RACK_HOLD_REPEAT_MS = 350;
const ENABLED_TILE_SELECTOR = ".tile[data-tile-id]:not(:disabled)";
const COMPUTER_RACK_PREFERENCE_KEY = "guppycube:show-computer-racks";
const RACK_AUTOSORT_PREFERENCE_KEY = "guppycube:rack-autosort";
const TURN_NOTIFICATIONS_PREFERENCE_KEY = "guppycube:turn-notifications";
const COLOR_THEME_PREFERENCE_KEY = "guppycube:color-theme";
const TILE_THEME_PREFERENCE_KEY = "guppycube:tile-theme";
const ALL_COMPUTER_RACKS = "*";

type BrowserNotificationPermission = NotificationPermission | "unsupported";

function browserNotificationPermission(): BrowserNotificationPermission {
  return typeof Notification === "undefined" ? "unsupported" : Notification.permission;
}

function legacyThemePreference(): string | null {
  return localStorage.getItem("guppycube:theme") ?? localStorage.getItem("rack-and-run:theme");
}

function storedColorThemeId(): string {
  return colorThemeById(localStorage.getItem(COLOR_THEME_PREFERENCE_KEY) ?? legacyThemePreference() ?? "").id;
}

function storedTileThemeId(): string {
  const stored = localStorage.getItem(TILE_THEME_PREFERENCE_KEY);
  return stored
    ? tileThemeById(stored).id
    : tileThemeIdFromLegacyTheme(legacyThemePreference());
}

function rackLayoutPreferenceKey(gameId: string, playerId: string): string {
  return `guppycube:rack-layout:${gameId}:${playerId}`;
}

function storedOpenComputerRackIds(): string[] {
  const stored = localStorage.getItem(COMPUTER_RACK_PREFERENCE_KEY);
  if (stored === "true") return [ALL_COMPUTER_RACKS];
  if (!stored || stored === "false") return [];
  try {
    const value: unknown = JSON.parse(stored);
    return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : [];
  } catch {
    return [];
  }
}

function isApplePlatform(): boolean {
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform);
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName);
}

function isShortcutTypingTarget(
  target: EventTarget | null,
  event: { key: string; metaKey: boolean; ctrlKey: boolean },
): boolean {
  if (target instanceof HTMLSelectElement && (event.metaKey || event.ctrlKey) && event.key === "Enter") {
    return false;
  }
  return isTypingTarget(target);
}

function tileButtons(root: ParentNode): HTMLButtonElement[] {
  return [...root.querySelectorAll<HTMLButtonElement>(ENABLED_TILE_SELECTOR)];
}

function tileIdFromEventTarget(target: EventTarget | null): string | null {
  if (!(target instanceof HTMLElement)) return null;
  return target.closest<HTMLElement>(ENABLED_TILE_SELECTOR)?.dataset.tileId ?? null;
}

function navigableGameElements(root: ParentNode, current: HTMLElement): HTMLElement[] {
  const rackTiles = tileButtons(root).filter((tile) => !tile.closest(".set-tiles"));
  const sets = [...root.querySelectorAll<HTMLElement>(".set[data-set-id]")];
  const currentSet = current.closest<HTMLElement>(".set");
  if (!currentSet) return [...rackTiles, ...sets];

  return [
    ...rackTiles,
    ...tileButtons(currentSet),
    ...sets.filter((set) => set !== currentSet),
  ];
}

function setsInRow(root: ParentNode, row: string | undefined): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(".set[data-set-id]")]
    .filter((set) => set.dataset.feltRow === row)
    .sort((left, right) => left.getBoundingClientRect().left - right.getBoundingClientRect().left);
}

function rackTiles(root: ParentNode): HTMLButtonElement[] {
  return tileButtons(root).filter((tile) => !tile.closest(".set-tiles"));
}

function horizontalSetSequenceTarget(
  current: HTMLElement,
  key: "ArrowLeft" | "ArrowRight",
): HTMLElement | null {
  const root = current.closest(".game-shell");
  const currentSet = current.closest<HTMLElement>(".set");
  if (!root || !currentSet) return null;

  const row = setsInRow(root, currentSet.dataset.feltRow);
  const setIndex = row.indexOf(currentSet);
  if (setIndex < 0) return null;

  const setTiles = tileButtons(currentSet);
  if (current === currentSet) {
    if (key === "ArrowRight") return setTiles[0] ?? currentSet;
    const previousSet = row[(setIndex - 1 + row.length) % row.length];
    return previousSet ? tileButtons(previousSet).at(-1) ?? previousSet : null;
  }

  const rowTiles = row.flatMap((set) => tileButtons(set));
  const tileIndex = rowTiles.indexOf(current as HTMLButtonElement);
  if (tileIndex < 0) return null;
  const nextIndex = key === "ArrowLeft"
    ? (tileIndex - 1 + rowTiles.length) % rowTiles.length
    : (tileIndex + 1) % rowTiles.length;
  return rowTiles[nextIndex] ?? null;
}

function verticalWrapTarget(
  current: HTMLElement,
  key: "ArrowDown" | "ArrowUp",
): HTMLElement | null {
  const root = current.closest(".game-shell");
  if (!root) return null;
  const feltSets = [...root.querySelectorAll<HTMLElement>(".set[data-set-id]")]
    .sort((left, right) => left.getBoundingClientRect().top - right.getBoundingClientRect().top
      || left.getBoundingClientRect().left - right.getBoundingClientRect().left);
  const rack = rackTiles(root);
  const currentSet = current.closest<HTMLElement>(".set");

  if (currentSet && feltSets.length > 0) {
    const edgeSet = key === "ArrowUp" ? feltSets[0] : feltSets.at(-1);
    const currentRow = currentSet.dataset.feltRow;
    const edgeRow = edgeSet?.dataset.feltRow;
    if (currentRow && currentRow === edgeRow) {
      return key === "ArrowUp" ? rack.at(-1) ?? null : rack[0] ?? null;
    }
  }

  if (current.classList.contains("tile") && !current.closest(".set-tiles") && rack.length > 0) {
    const currentLevel = current.closest<HTMLElement>(".rack-level");
    const levels = [...root.querySelectorAll<HTMLElement>(".rack-level")];
    const currentLevelIndex = currentLevel ? levels.indexOf(currentLevel) : -1;
    const atRackEdge = key === "ArrowUp"
      ? currentLevelIndex === 0
      : currentLevelIndex === levels.length - 1;
    if (atRackEdge) return key === "ArrowUp" ? feltSets.at(-1) ?? null : feltSets[0] ?? null;
  }

  return null;
}

function directionalRackTile(
  current: HTMLElement,
  key: "ArrowDown" | "ArrowLeft" | "ArrowRight" | "ArrowUp",
): HTMLElement | null {
  const root = current.closest(".game-shell");
  const currentLevel = current.closest<HTMLElement>(".rack-level");
  if (!root || !currentLevel) return null;

  const rowTiles = tileButtons(currentLevel).sort((left, right) =>
    left.getBoundingClientRect().left - right.getBoundingClientRect().left,
  );
  if (key === "ArrowLeft" || key === "ArrowRight") {
    if (rowTiles.length < 2) return null;
    const currentIndex = rowTiles.indexOf(current as HTMLButtonElement);
    if (currentIndex < 0) return null;
    const nextIndex = key === "ArrowLeft"
      ? (currentIndex - 1 + rowTiles.length) % rowTiles.length
      : (currentIndex + 1) % rowTiles.length;
    return rowTiles[nextIndex] ?? null;
  }

  const levels = [...root.querySelectorAll<HTMLElement>(".rack-level")];
  const currentLevelIndex = levels.indexOf(currentLevel);
  const targetLevel = levels[currentLevelIndex + (key === "ArrowUp" ? -1 : 1)];
  if (!targetLevel) return null;

  const currentBox = current.getBoundingClientRect();
  const currentX = currentBox.left + currentBox.width / 2;
  return tileButtons(targetLevel)
    .map((candidate) => {
      const box = candidate.getBoundingClientRect();
      return { candidate, distance: Math.abs(box.left + box.width / 2 - currentX) };
    })
    .sort((left, right) => left.distance - right.distance)[0]?.candidate ?? null;
}

function directionalSet(
  current: HTMLElement,
  key: "ArrowDown" | "ArrowLeft" | "ArrowRight" | "ArrowUp",
): HTMLElement | null {
  const root = current.closest(".game-shell");
  const currentSet = current.closest<HTMLElement>(".set");
  if (!root || !currentSet) return null;

  const currentBox = currentSet.getBoundingClientRect();
  const currentX = currentBox.left + currentBox.width / 2;
  const currentY = currentBox.top + currentBox.height / 2;
  const horizontal = key === "ArrowLeft" || key === "ArrowRight";
  const direction = key === "ArrowLeft" || key === "ArrowUp" ? -1 : 1;

  const candidates = [...root.querySelectorAll<HTMLElement>(".set[data-set-id]")]
    .filter((set) => set !== currentSet)
    .filter((set) => !horizontal || set.dataset.feltRow === currentSet.dataset.feltRow);
  const next = candidates
    .map((set) => {
      const box = set.getBoundingClientRect();
      const dx = box.left + box.width / 2 - currentX;
      const dy = box.top + box.height / 2 - currentY;
      const primary = (horizontal ? dx : dy) * direction;
      const secondary = Math.abs(horizontal ? dy : dx);
      return { set, primary, score: primary + secondary * 3 };
    })
    .filter(({ primary }) => primary > 2)
    .sort((left, right) => left.score - right.score)[0]?.set;

  if (next) return next;
  if (!horizontal) return null;
  const row = setsInRow(root, currentSet.dataset.feltRow);
  return key === "ArrowLeft" ? row.at(-1) ?? null : row[0] ?? null;
}

function directionalTile(
  current: HTMLElement,
  key: "ArrowDown" | "ArrowLeft" | "ArrowRight" | "ArrowUp",
  shiftKey = false,
): HTMLElement | null {
  const root = current.closest(".game-shell");
  if (!root) return null;
  const currentBox = current.getBoundingClientRect();
  const currentX = currentBox.left + currentBox.width / 2;
  const currentY = currentBox.top + currentBox.height / 2;
  const horizontal = key === "ArrowLeft" || key === "ArrowRight";
  const direction = key === "ArrowLeft" || key === "ArrowUp" ? -1 : 1;

  const isRackTile = current.classList.contains("tile") && !current.closest(".set-tiles");
  const currentSet = current.closest(".set");
  if (isRackTile) {
    const nextRackTile = directionalRackTile(current, key);
    if (nextRackTile) return nextRackTile;
    if (!horizontal) return verticalWrapTarget(current, key);
    return null;
  }
  if (currentSet && (key === "ArrowUp" || key === "ArrowDown" || (shiftKey && horizontal))) {
    return directionalSet(current, key);
  }
  if (currentSet && horizontal) {
    return horizontalSetSequenceTarget(current, key);
  }
  const candidates = navigableGameElements(root, current);

  return candidates
    .filter((candidate) => candidate !== current)
    .map((candidate) => {
      const box = candidate.getBoundingClientRect();
      const dx = box.left + box.width / 2 - currentX;
      const dy = box.top + box.height / 2 - currentY;
      const primary = (horizontal ? dx : dy) * direction;
      const secondary = Math.abs(horizontal ? dy : dx);
      return { candidate, primary, score: primary + secondary * 3 };
    })
    .filter(({ primary }) => primary > 2)
    .sort((left, right) => left.score - right.score)[0]?.candidate ?? null;
}
const ACTION_FLASH_MS = 4_200;
const NEW_ACTIVITY_MS = 3_600;
const TURN_EVENT_KINDS = new Set<GameEvent["kind"]>(["played", "drew", "timeout"]);

function timeLabel(deadline: number | null, now: number): string {
  if (!deadline) return "—";
  const remaining = Math.max(0, deadline - now);
  if (remaining >= 60 * 60 * 1000) {
    const hours = Math.floor(remaining / (60 * 60 * 1000));
    const minutes = Math.floor((remaining % (60 * 60 * 1000)) / 60_000);
    return `${hours}h ${minutes}m`;
  }
  const minutes = Math.floor(remaining / 60_000);
  const seconds = Math.floor((remaining % 60_000) / 1000);
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function boardKey(board: GameSet[]): string {
  return JSON.stringify(
    board
      .map((set) => [...set.tileIds].sort().join("|"))
      .sort(),
  );
}

function setMembershipKey(tileIds: string[]): string {
  return [...new Set(tileIds)].sort().join("|");
}

function changedSetIds(board: GameSet[], originalBoard: GameSet[]): Set<string> {
  const originalSetsById = new Map(originalBoard.map((set) => [set.id, setMembershipKey(set.tileIds)]));
  return new Set(
    board
      .filter((set) => originalSetsById.get(set.id) !== setMembershipKey(set.tileIds))
      .map((set) => set.id),
  );
}

function draftKey(draft: TurnDraft): string {
  return JSON.stringify({
    board: draft.board.map((set) => set.tileIds),
    rackSlots: draft.rackLayout.slots,
  });
}

function authoritativePositionKey(game: PublicGameState | null): string {
  if (!game) return "";
  const visibleOpponentDraft = game.currentPlayerId === game.myPlayerId ? null : game.turnDraft;
  return JSON.stringify({
    status: game.status,
    currentPlayerId: game.currentPlayerId,
    board: game.board.map((set) => set.tileIds),
    rack: [...game.myRack].sort(),
    turnDraft: visibleOpponentDraft?.map((set) => set.tileIds) ?? null,
    opened: game.players.find((player) => player.id === game.myPlayerId)?.opened ?? false,
  });
}

function initials(name: string): string {
  return name.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toLocaleUpperCase();
}

function turnActionSummary(item: GameEvent, playerName: string): string {
  const possessivePrefix = `${playerName}'s `;
  const namePrefix = `${playerName} `;
  const summary = item.message.startsWith(possessivePrefix)
    ? item.message.slice(possessivePrefix.length)
    : item.message.startsWith(namePrefix)
      ? item.message.slice(namePrefix.length)
      : item.message;
  return summary.replace(/\.$/, "");
}

function AssistControls({
  game,
  busy,
  onToggle,
}: {
  game: PublicGameState;
  busy: boolean;
  onToggle: (assistId: AssistId, enabled: boolean) => void;
}) {
  return (
    <div className="assist-controls">
      {ASSIST_DEFINITIONS.map((assist) => {
        const disallowed = game.assistPolicy[assist.id] === "disallowed";
        const enabled = !disallowed && game.enabledAssists.includes(assist.id);
        return (
          <label className={disallowed ? "is-disallowed" : ""} key={assist.id}>
            <span><strong>{assist.label}</strong><small>{assist.description}</small></span>
            {disallowed ? (
              <b>Not allowed</b>
            ) : (
              <input
                type="checkbox"
                role="switch"
                aria-label={assist.label}
                checked={enabled}
                disabled={busy}
                onChange={(event) => onToggle(assist.id, event.target.checked)}
              />
            )}
          </label>
        );
      })}
    </div>
  );
}

export function Game({ session, onExit, onSessionMissing, onShowRules }: GameProps) {
  const [game, setGame] = useState<PublicGameState | null>(null);
  const [draftBoard, setDraftBoard] = useState<GameSet[]>([]);
  const [draftRackLayout, setDraftRackLayout] = useState<RackLayout>(() => createRackLayout([]));
  const [rackLayoutOwnerKey, setRackLayoutOwnerKey] = useState<string | null>(null);
  const [turnHistory, setTurnHistory] = useState<TurnDraft[]>([]);
  const [turnHistoryIndex, setTurnHistoryIndex] = useState(0);
  const [selectedTileIds, setSelectedTileIds] = useState<string[]>([]);
  const [draggedItem, setDraggedItem] = useState<DragItem | null>(null);
  const [rackDropTarget, setRackDropTarget] = useState<{ slotIndex: number; side: RackDropSide } | null>(null);
  const [dropTargetSetId, setDropTargetSetId] = useState<string | null>(null);
  const [connection, setConnection] = useState<"connecting" | "online" | "offline">("connecting");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [interactionAnnouncement, setInteractionAnnouncement] = useState("");
  const [focusedTileId, setFocusedTileId] = useState<string | null>(null);
  const [focusedSetId, setFocusedSetId] = useState<string | null>(null);
  const [keyboardNavigationActive, setKeyboardNavigationActive] = useState(false);
  const [copied, setCopied] = useState(false);
  const [portableLink, setPortableLink] = useState<string | null>(null);
  const [showActivity, setShowActivity] = useState(false);
  const [showAssists, setShowAssists] = useState(false);
  const [showAppearance, setShowAppearance] = useState(false);
  const [showNotifications, setShowNotifications] = useState(false);
  const [turnNotificationsEnabled, setTurnNotificationsEnabled] = useState(() =>
    localStorage.getItem(TURN_NOTIFICATIONS_PREFERENCE_KEY) === "true",
  );
  const [notificationPermission, setNotificationPermission] = useState<BrowserNotificationPermission>(
    browserNotificationPermission,
  );
  const [flashedAction, setFlashedAction] = useState<GameEvent | null>(null);
  const [newActivityTileIds, setNewActivityTileIds] = useState<string[]>([]);
  const [openComputerRackIds, setOpenComputerRackIds] = useState(storedOpenComputerRackIds);
  const [computerStrategy, setComputerStrategy] = useState<ComputerStrategyId>("basic");
  const [colorThemeId, setColorThemeId] = useState(storedColorThemeId);
  const [tileThemeId, setTileThemeId] = useState(storedTileThemeId);
  const [rackSortMode, setRackSortMode] = useState<TileSortMode>(() =>
    localStorage.getItem("guppycube:rack-sort") === "number-first" ? "number-first" : "color-first",
  );
  const [rackAutoSort, setRackAutoSort] = useState(() =>
    localStorage.getItem(RACK_AUTOSORT_PREFERENCE_KEY) !== "false",
  );
  const [feltBounds, setFeltBounds] = useState({
    width: 0,
    height: 0,
    obstacleWidth: 0,
    obstacleHeight: 0,
  });
  const [now, setNow] = useState(Date.now());
  const feltRef = useRef<HTMLDivElement>(null);
  const poolRef = useRef<HTMLButtonElement>(null);
  const rackHoldTimer = useRef<number | null>(null);
  const rackHoldRun = useRef(0);
  const rackHoldPointerId = useRef<number | null>(null);
  const tileDragPreview = useRef<HTMLElement | null>(null);
  const suppressTileClick = useRef<string | null>(null);
  const doubleClickSetId = useRef<string | null>(null);
  const selectionAnchorId = useRef<string | null>(null);
  const actionRoomId = useRef<string | null>(null);
  const seenTurnActionIds = useRef<Set<string>>(new Set());
  const observedBoardTileIds = useRef<Set<string>>(new Set());
  const observedRackTileIds = useRef<Set<string>>(new Set());
  const actionFlashTimer = useRef<number | null>(null);
  const newActivityTimer = useRef<number | null>(null);
  const previousTurn = useRef<{
    gameId: string;
    currentPlayerId: string | null;
  } | null>(null);
  const draftSequence = useRef(0);
  const gameShortcutRef = useRef<(event: KeyboardEvent) => void>(() => {});
  const feltLayoutMemory = useRef<{
    width: number;
    height: number;
    obstacleWidth: number;
    obstacleHeight: number;
    layout: FeltLayout;
  } | null>(null);
  const positionKey = authoritativePositionKey(game);

  const refresh = useCallback(async () => {
    const next = await getGame(session);
    setGame((current) => mergeGameState(current, next, "request"));
    return next;
  }, [session]);

  useEffect(() => {
    let active = true;
    refresh().catch((caught) => {
      if (!active) return;
      if (caught instanceof ApiRequestError && caught.status === 401) {
        onSessionMissing(session.roomCode);
        return;
      }
      setError(caught instanceof Error ? caught.message : "Could not load the table.");
    });
    return () => { active = false; };
  }, [onSessionMissing, refresh, session.roomCode]);

  useEffect(() => {
    let active = true;
    getPlayerLink(session)
      .then(({ link }) => {
        if (active) setPortableLink(link);
      })
      .catch(() => {
        // The table state request remains the source of truth for session errors.
      });
    return () => { active = false; };
  }, [session]);

  useEffect(() => {
    let closed = false;
    let reconnectTimer: number | undefined;
    let retry = 0;
    let socket: WebSocket | null = null;

    const connect = () => {
      if (closed) return;
      setConnection("connecting");
      socket = new WebSocket(socketUrl(session));
      socket.addEventListener("open", () => {
        retry = 0;
        setConnection("online");
      });
      socket.addEventListener("message", (message) => {
        try {
          const payload: unknown = JSON.parse(String(message.data));
          if (!validators.serverSocketMessage(payload)) throw new Error("Invalid WebSocket message");
          if (payload.type === "state") {
            setGame((current) => mergeGameState(current, payload.state, "socket"));
          }
          else if (payload.type === "error") setError(payload.error);
        } catch {
          setError("The table sent an unreadable update.");
        }
      });
      socket.addEventListener("close", () => {
        if (closed) return;
        setConnection("offline");
        retry += 1;
        reconnectTimer = window.setTimeout(connect, Math.min(10_000, 800 * 2 ** retry));
      });
      socket.addEventListener("error", () => setConnection("offline"));
    };
    connect();
    return () => {
      closed = true;
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      socket?.close(1000, "Page closed");
    };
  }, [session]);

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    const updatePermission = () => setNotificationPermission(browserNotificationPermission());
    document.addEventListener("visibilitychange", updatePermission);
    return () => document.removeEventListener("visibilitychange", updatePermission);
  }, []);

  useEffect(() => {
    if (!game) return;
    const previous = previousTurn.current;
    previousTurn.current = {
      gameId: game.id,
      currentPlayerId: game.currentPlayerId,
    };
    if (
      !previous
      || previous.gameId !== game.id
      || previous.currentPlayerId === game.myPlayerId
      || game.currentPlayerId !== game.myPlayerId
      || game.status !== "playing"
      || !turnNotificationsEnabled
      || notificationPermission !== "granted"
      || document.visibilityState !== "hidden"
    ) return;

    try {
      const notification = new Notification("Your turn", {
        body: `It's your turn at ${game.id}.`,
        tag: `guppycube-turn-${game.id}`,
        silent: true,
      });
      notification.onclick = () => {
        window.focus();
        notification.close();
      };
    } catch {
      setNotificationPermission(browserNotificationPermission());
    }
  }, [game, notificationPermission, turnNotificationsEnabled]);

  useEffect(() => () => {
    if (actionFlashTimer.current !== null) window.clearTimeout(actionFlashTimer.current);
    if (newActivityTimer.current !== null) window.clearTimeout(newActivityTimer.current);
    tileDragPreview.current?.remove();
  }, []);

  useEffect(() => {
    if (!game) return;
    const boardTileIds = new Set(game.board.flatMap((set) => set.tileIds));
    const rackTileIds = new Set(game.myRack);
    const turnActions = game.history.filter((item) =>
      item.playerId !== null
      && TURN_EVENT_KINDS.has(item.kind),
    );

    if (actionRoomId.current !== game.id) {
      actionRoomId.current = game.id;
      seenTurnActionIds.current = new Set(turnActions.map((item) => item.id));
      observedBoardTileIds.current = boardTileIds;
      observedRackTileIds.current = rackTileIds;
      setFlashedAction(null);
      setNewActivityTileIds([]);
      return;
    }

    const unseenActions = turnActions.filter((item) => !seenTurnActionIds.current.has(item.id));
    for (const item of turnActions) seenTurnActionIds.current.add(item.id);
    const latestAction = unseenActions.at(-1);
    const previousBoardTileIds = observedBoardTileIds.current;
    const previousRackTileIds = observedRackTileIds.current;
    observedBoardTileIds.current = boardTileIds;
    observedRackTileIds.current = rackTileIds;

    const newBoardTileIds = latestAction?.kind === "played"
      ? [...boardTileIds].filter((tileId) => !previousBoardTileIds.has(tileId))
      : [];
    const newRackTileIds = latestAction?.kind === "drew" && latestAction.playerId === game.myPlayerId
      ? [...rackTileIds].filter((tileId) => !previousRackTileIds.has(tileId))
      : [];
    const activityTileIds = [...new Set([...newBoardTileIds, ...newRackTileIds])];

    if (activityTileIds.length > 0) {
      setNewActivityTileIds(activityTileIds);
      if (newActivityTimer.current !== null) window.clearTimeout(newActivityTimer.current);
      newActivityTimer.current = window.setTimeout(() => {
        setNewActivityTileIds([]);
        newActivityTimer.current = null;
      }, NEW_ACTIVITY_MS);
    }

    if (!latestAction) return;

    setFlashedAction(latestAction);
    if (actionFlashTimer.current !== null) window.clearTimeout(actionFlashTimer.current);
    actionFlashTimer.current = window.setTimeout(() => {
      setFlashedAction(null);
      actionFlashTimer.current = null;
    }, ACTION_FLASH_MS);
  }, [game]);

  useEffect(() => {
    localStorage.setItem(
      COMPUTER_RACK_PREFERENCE_KEY,
      openComputerRackIds.includes(ALL_COMPUTER_RACKS) ? "true" : JSON.stringify(openComputerRackIds),
    );
  }, [openComputerRackIds]);

  useEffect(() => {
    const cancelRackHoldOnPointerEnd = (event: PointerEvent) => {
      if (rackHoldPointerId.current === event.pointerId) cancelRackHold();
    };

    window.addEventListener("pointerup", cancelRackHoldOnPointerEnd, true);
    window.addEventListener("pointercancel", cancelRackHoldOnPointerEnd, true);
    return () => {
      window.removeEventListener("pointerup", cancelRackHoldOnPointerEnd, true);
      window.removeEventListener("pointercancel", cancelRackHoldOnPointerEnd, true);
      cancelRackHold();
    };
  }, []);

  useLayoutEffect(() => {
    const felt = feltRef.current;
    const pool = poolRef.current;
    if (!felt || !pool) return;

    const measure = () => {
      const feltRect = felt.getBoundingClientRect();
      const poolRect = pool.getBoundingClientRect();
      const overlapLeft = Math.max(feltRect.left, poolRect.left);
      const overlapRight = Math.min(feltRect.right, poolRect.right);
      const overlapBottom = Math.min(feltRect.bottom, poolRect.bottom);
      const drawPileOverlapsFelt = overlapLeft < overlapRight && feltRect.top < overlapBottom;
      const next = {
        width: felt.clientWidth,
        height: felt.clientHeight,
        obstacleWidth: drawPileOverlapsFelt
          ? Math.max(0, Math.min(felt.clientWidth, feltRect.right - overlapLeft + 4))
          : 0,
        obstacleHeight: drawPileOverlapsFelt
          ? Math.max(0, Math.min(felt.clientHeight, overlapBottom - feltRect.top + 4))
          : 0,
      };
      setFeltBounds((current) => Object.keys(next).every((key) =>
        current[key as keyof typeof current] === next[key as keyof typeof next]
      ) ? current : next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(felt);
    observer.observe(pool);
    return () => observer.disconnect();
  }, [game?.status]);

  useEffect(() => {
    if (!game) return;
    const normalizedBoard = (source: GameSet[]) => source.map((set) => ({
      ...set,
      tileIds: normalizeSetTileIds(set.tileIds, game.tiles),
    }));
    const baseBoard = normalizedBoard(game.board);
    const visibleBoard = game.currentPlayerId === game.myPlayerId
      ? game.myTurnDraft
      : game.turnDraft;
    const layoutKey = rackLayoutPreferenceKey(game.id, game.myPlayerId);
    const storedLayout = parseRackLayout(localStorage.getItem(layoutKey));
    const layoutForBoard = (board: GameSet[]): RackLayout => {
      const draftedTileIds = new Set(board.flatMap((set) => set.tileIds));
      const rackTileIds = game.myRack.filter((tileId) => !draftedTileIds.has(tileId));
      return rackAutoSort
        ? createRackLayout(sortTileIds(rackTileIds, game.tiles, rackSortMode))
        : reconcileRackLayout(
            storedLayout ?? createRackLayout(rackTileIds),
            rackTileIds,
            MANUAL_RACK_SLOTS_PER_ROW,
          );
    };
    const board = normalizedBoard(visibleBoard ?? game.board);
    const baseRackLayout = layoutForBoard(baseBoard);
    const rackLayout = layoutForBoard(board);
    const history = boardKey(board) === boardKey(baseBoard)
      ? [{ board: baseBoard, rackLayout: baseRackLayout }]
      : [
          { board: baseBoard, rackLayout: baseRackLayout },
          { board, rackLayout },
        ];
    setDraftBoard(board);
    setDraftRackLayout(rackLayout);
    setRackLayoutOwnerKey(layoutKey);
    setTurnHistory(history);
    setTurnHistoryIndex(history.length - 1);
    setSelectedTileIds([]);
    setDraggedItem(null);
    setRackDropTarget(null);
    setDropTargetSetId(null);
    doubleClickSetId.current = null;
    selectionAnchorId.current = null;
    setFocusedTileId(null);
    setKeyboardNavigationActive(false);
    setInteractionAnnouncement("");
    setError("");
  }, [positionKey]);

  useEffect(() => {
    if (!game) return;
    const layoutKey = rackLayoutPreferenceKey(game.id, game.myPlayerId);
    if (rackLayoutOwnerKey !== layoutKey) return;
    localStorage.setItem(
      layoutKey,
      JSON.stringify(draftRackLayout),
    );
  }, [draftRackLayout, game?.id, game?.myPlayerId, rackLayoutOwnerKey]);

  const me = game?.players.find((player) => player.id === game.myPlayerId);
  const currentPlayer = game?.players.find((player) => player.id === game.currentPlayerId);
  const isMyTurn = game?.status === "playing" && game.currentPlayerId === game.myPlayerId;
  const draftRack = useMemo(() => rackTileIds(draftRackLayout), [draftRackLayout]);
  const dirty = game ? boardKey(draftBoard) !== boardKey(game.board) : false;
  const originalBoardTiles = useMemo(() => new Set(game?.board.flatMap((set) => set.tileIds) ?? []), [positionKey]);
  const originalRackTiles = useMemo(() => new Set(game?.myRack ?? []), [positionKey]);
  const selectionCanReturnToRack = selectedTileIds.length > 0
    && selectedTileIds.every((tileId) => originalRackTiles.has(tileId))
    && selectedTileIds.some((tileId) => !draftRack.includes(tileId));
  const activeColorTheme = colorThemeById(colorThemeId);
  const activeTileTheme = tileThemeById(tileThemeId);
  const shortcutModifier = useMemo(() => isApplePlatform() ? "⌘" : "Ctrl", []);
  const redoShortcut = useMemo(() => isApplePlatform() ? `${shortcutModifier}⇧Z` : `${shortcutModifier}Y`, [shortcutModifier]);
  const optionModifier = useMemo(() => isApplePlatform() ? "⌥" : "Alt", []);
  const rackRows = useMemo(() => rackSlotRows(draftRackLayout), [draftRackLayout]);
  const autosortedSetTileIds = useMemo(() => new Set(
    rackAutoSort && game?.enabledAssists.includes("rack-set-highlights")
      ? groupSortedRackTileIds(draftRack, game.tiles)
          .filter((group) => group.isSet)
          .flatMap((group) => group.tileIds)
      : [],
  ), [draftRack, game, rackAutoSort]);

  const turnValidation = useMemo(() => {
    if (!game || !me || !isMyTurn) return null;
    return validateTurn({
      previousBoard: game.board,
      proposedBoard: draftBoard,
      rack: game.myRack,
      opened: me.opened,
      tiles: game.tiles,
    });
  }, [draftBoard, game, isMyTurn, me]);
  const canCommit = turnValidation?.valid === true;
  const hasLiveOpponentDraft = !isMyTurn
    && game?.turnDraft !== null
    && boardKey(draftBoard) !== boardKey(game?.board ?? []);
  const opponentTurnValidation = useMemo(() => {
    if (!game || !currentPlayer || !hasLiveOpponentDraft) return null;
    const tableTileIds = new Set(game.board.flatMap((set) => set.tileIds));
    const attemptedTileIds = draftBoard
      .flatMap((set) => set.tileIds)
      .filter((tileId) => !tableTileIds.has(tileId));
    return validateTurn({
      previousBoard: game.board,
      proposedBoard: draftBoard,
      rack: attemptedTileIds,
      opened: currentPlayer.opened,
      tiles: game.tiles,
    });
  }, [currentPlayer, draftBoard, game, hasLiveOpponentDraft]);
  const visibleTurnValidation = isMyTurn ? turnValidation : opponentTurnValidation;
  const hasBoardDefect = (isMyTurn ? dirty : hasLiveOpponentDraft)
    && visibleTurnValidation?.valid === false;

  const openingPoints = useMemo(() => {
    if (!game || me?.opened) return 0;
    return draftBoard.reduce((sum, set) => {
      if (!set.tileIds.some((id) => originalRackTiles.has(id))) return sum;
      if (set.tileIds.some((id) => !originalRackTiles.has(id))) return sum;
      const result = validateSet(set.tileIds, game.tiles);
      return sum + (result.valid ? result.points : 0);
    }, 0);
  }, [draftBoard, game, me?.opened, originalRackTiles]);

  const draftChangedSetIds = useMemo(
    () => changedSetIds(draftBoard, game?.board ?? []),
    [draftBoard, game?.board],
  );

  const feltLayout = useMemo(() => {
    const previous = feltLayoutMemory.current;
    const sameBounds = previous
      && previous.width === feltBounds.width
      && previous.height === feltBounds.height
      && previous.obstacleWidth === feltBounds.obstacleWidth
      && previous.obstacleHeight === feltBounds.obstacleHeight;
    const next = createFeltLayout(
      draftBoard.map((set, placementOrder) => ({
        id: set.id,
        tileCount: set.tileIds.length,
        placementOrder,
        orderKey: set.tileIds.map((tileId) => {
          const tile = game?.tiles[tileId];
          if (!tile) return `missing:${tileId}`;
          return tile.wilcard
            ? "wilcard"
            : `${tile.color ?? ""}:${String(tile.value ?? 0).padStart(2, "0")}`;
        }).join("|"),
      })),
      feltBounds.width,
      feltBounds.height,
      { width: feltBounds.obstacleWidth, height: feltBounds.obstacleHeight },
      sameBounds ? previous.layout : undefined,
    );
    feltLayoutMemory.current = {
      width: feltBounds.width,
      height: feltBounds.height,
      obstacleWidth: feltBounds.obstacleWidth,
      obstacleHeight: feltBounds.obstacleHeight,
      layout: next,
    };
    return next;
  }, [
    draftBoard,
    feltBounds.height,
    feltBounds.obstacleHeight,
    feltBounds.obstacleWidth,
    feltBounds.width,
    game?.tiles,
  ]);

  function tileName(tileId: string): string {
    const tile = game?.tiles[tileId];
    if (!tile) return "Tile";
    return tile.wilcard ? "Wilcard" : `${tile.color} ${tile.value}`;
  }

  function feltSetNumber(setId: string): number {
    const canonicalIndex = feltLayout.placements.findIndex((placement) => placement.id === setId);
    return canonicalIndex >= 0 ? canonicalIndex + 1 : draftBoard.findIndex((set) => set.id === setId) + 1;
  }

  function focusTileNavigation(
    direction?: "ArrowDown" | "ArrowLeft" | "ArrowRight" | "ArrowUp",
  ) {
    if (!isMyTurn) return;
    const rack = document.querySelector(".rack");
    if (!rack) return;
    const candidates = tileButtons(rack);
    if (candidates.length === 0) return;

    const previous = candidates.find((tile) => tile.dataset.tileId === focusedTileId);
    const selected = candidates.find((tile) => tile.dataset.tileId && selectedTileIds.includes(tile.dataset.tileId));
    let next: HTMLElement | undefined = previous ?? selected;
    if (next && direction) next = directionalTile(next, direction) ?? next;
    if (!next) next = direction === "ArrowLeft" || direction === "ArrowUp" ? candidates.at(-1) : candidates[0];
    const tileId = next?.dataset.tileId;
    if (!next || !tileId) return;

    setKeyboardNavigationActive(true);
    setFocusedTileId(tileId);
    next.focus({ preventScroll: true });
    setInteractionAnnouncement(`${tileName(tileId)} focused. Use the arrow keys to move and Space to select.`);
  }

  function handleTileFocus(tileId: string) {
    setFocusedTileId(tileId);
    setFocusedSetId(null);
    setKeyboardNavigationActive(true);
  }

  function handleSetFocus(setId: string) {
    setFocusedTileId(null);
    setFocusedSetId(setId);
    setKeyboardNavigationActive(true);
    setInteractionAnnouncement(`Set ${feltSetNumber(setId)} focused. Press Space to select the whole set.`);
  }

  function announceSelection(tileIds: string[], changedTileId?: string) {
    if (tileIds.length === 0) {
      setInteractionAnnouncement("Selection cleared.");
      return;
    }
    const changed = changedTileId ? `${tileName(changedTileId)}. ` : "";
    setInteractionAnnouncement(`${changed}${tileIds.length} ${tileIds.length === 1 ? "tile" : "tiles"} selected.`);
  }

  function toggleTileSelection(tileId: string) {
    const next = selectedTileIds.includes(tileId)
      ? selectedTileIds.filter((selectedId) => selectedId !== tileId)
      : [...selectedTileIds, tileId];
    selectionAnchorId.current = tileId;
    setSelectedTileIds(next);
    setDraggedItem(null);
    announceSelection(next, tileId);
  }

  function tileSequence(tileId: string): string[] {
    if (draftRack.includes(tileId)) return draftRack;
    return draftBoard.find((set) => set.tileIds.includes(tileId))?.tileIds ?? [];
  }

  function selectTileRange(tileId: string) {
    const anchorId = selectionAnchorId.current;
    const sequence = tileSequence(tileId);
    const anchorIndex = anchorId ? sequence.indexOf(anchorId) : -1;
    const tileIndex = sequence.indexOf(tileId);
    if (anchorIndex < 0 || tileIndex < 0) {
      selectionAnchorId.current = tileId;
      setSelectedTileIds([tileId]);
      announceSelection([tileId], tileId);
      return;
    }
    const range = sequence.slice(Math.min(anchorIndex, tileIndex), Math.max(anchorIndex, tileIndex) + 1);
    setSelectedTileIds(range);
    setDraggedItem(null);
    announceSelection(range, tileId);
  }

  function extendSelectionTo(currentTileId: string, nextTileId: string) {
    if (!selectionAnchorId.current) selectionAnchorId.current = currentTileId;
    const next = [...new Set([...selectedTileIds, currentTileId, nextTileId])];
    setSelectedTileIds(next);
    setDraggedItem(null);
    announceSelection(next, nextTileId);
  }

  function clearTurnInteraction() {
    setSelectedTileIds([]);
    setDraggedItem(null);
    setRackDropTarget(null);
    setDropTargetSetId(null);
    selectionAnchorId.current = null;
    setError("");
  }

  function syncTurnDraft(board: GameSet[]) {
    if (!game || !isMyTurn || game.turnStartedAt === null) return;
    const sequence = Math.max(Date.now(), draftSequence.current + 1);
    draftSequence.current = sequence;
    void saveTurnDraft(session, {
      turnStartedAt: game.turnStartedAt,
      sequence,
      board,
    }).catch((caught) => {
      if (sequence !== draftSequence.current) return;
      if (caught instanceof ApiRequestError && caught.status === 409) return;
      setError(caught instanceof Error ? caught.message : "Could not save your in-progress turn.");
    });
  }

  function recordDraft(board: GameSet[], rackLayout: RackLayout) {
    const nextDraft = { board, rackLayout };
    if (draftKey(nextDraft) === draftKey({ board: draftBoard, rackLayout: draftRackLayout })) {
      clearTurnInteraction();
      return;
    }
    setTurnHistory((history) => [...history.slice(0, turnHistoryIndex + 1), nextDraft]);
    setTurnHistoryIndex(turnHistoryIndex + 1);
    setDraftBoard(board);
    setDraftRackLayout(rackLayout);
    if (boardKey(board) !== boardKey(draftBoard)) syncTurnDraft(board);
    clearTurnInteraction();
  }

  function showTurnHistory(index: number) {
    if (!game || index < 0 || index >= turnHistory.length) return;
    const draft = turnHistory[index];
    if (!draft) return;
    setTurnHistoryIndex(index);
    setDraftBoard(draft.board);
    setDraftRackLayout(rackAutoSort
      ? createRackLayout(
          sortTileIds(rackTileIds(draft.rackLayout), game.tiles, rackSortMode),
        )
      : draft.rackLayout);
    if (boardKey(draft.board) !== boardKey(draftBoard)) syncTurnDraft(draft.board);
    clearTurnInteraction();
  }

  function moveTiles(tileIds: string[], target: MoveTarget) {
    if (!game) return;
    const movingTileIds = [...new Set(tileIds)].filter((tileId) => game.tiles[tileId]);
    if (movingTileIds.length === 0) return;
    const movingTiles = new Set(movingTileIds);

    const personalRackSlotIndex = target.type === "rack"
      && target.slotIndex !== undefined
      && movingTileIds.every((tileId) => draftRack.includes(tileId))
      ? target.slotIndex
      : null;
    if (personalRackSlotIndex !== null) {
      // Dropping a tile back onto the slot it already occupies is a no-op.
      // Check this before converting an autosorted rack to the expanded manual
      // layout; otherwise an unchanged drop turns sorting off and shifts the
      // tiles into the manual rack's wider slot grid.
      const currentRackPlacement = placeRackTilesAtSlot(
        draftRackLayout,
        movingTileIds,
        personalRackSlotIndex,
        target.type === "rack" ? target.side : undefined,
      );
      const rackPlacementUnchanged = currentRackPlacement.slotsPerRow === draftRackLayout.slotsPerRow
        && currentRackPlacement.slots.length === draftRackLayout.slots.length
        && currentRackPlacement.slots.every((tileId, index) => tileId === draftRackLayout.slots[index]);
      if (rackPlacementUnchanged) {
        clearTurnInteraction();
        return;
      }

      const manualRackLayout = rackAutoSort
        ? reconcileRackLayout(draftRackLayout, draftRack, MANUAL_RACK_SLOTS_PER_ROW)
        : draftRackLayout;
      const nextRackLayout = placeRackTilesAtSlot(
        manualRackLayout,
        movingTileIds,
        personalRackSlotIndex,
        target.type === "rack" ? target.side : undefined,
      );
      setRackAutoSort(false);
      localStorage.setItem(RACK_AUTOSORT_PREFERENCE_KEY, "false");
      setDraftRackLayout(nextRackLayout);
      setTurnHistory((history) => history.map((draft) => {
        const tileIdsInDraftRack = new Set(rackTileIds(draft.rackLayout));
        const manualDraftLayout = rackAutoSort
          ? reconcileRackLayout(draft.rackLayout, rackTileIds(draft.rackLayout), MANUAL_RACK_SLOTS_PER_ROW)
          : draft.rackLayout;
        return movingTileIds.every((tileId) => tileIdsInDraftRack.has(tileId))
          ? {
              ...draft,
              rackLayout: placeRackTilesAtSlot(
                manualDraftLayout,
                movingTileIds,
                personalRackSlotIndex,
                target.type === "rack" ? target.side : undefined,
              ),
            }
          : draft;
      }));
      localStorage.setItem(
        rackLayoutPreferenceKey(game.id, game.myPlayerId),
        JSON.stringify(nextRackLayout),
      );
      clearTurnInteraction();
      setInteractionAnnouncement(`Moved ${movingTileIds.length} ${movingTileIds.length === 1 ? "tile" : "tiles"} on your rack.`);
      return;
    }

    if (!isMyTurn) return;

    if (target.type === "rack" && movingTileIds.some((tileId) => originalBoardTiles.has(tileId))) {
      setError("A table tile cannot return to your rack. Move it into another set.");
      return;
    }

    const sourceSetIds = new Set(
      draftBoard
        .filter((set) => set.tileIds.some((tileId) => movingTiles.has(tileId)))
        .map((set) => set.id),
    );
    if (target.type === "set" && sourceSetIds.size === 1 && sourceSetIds.has(target.setId)) {
      setSelectedTileIds([]);
      setDraggedItem(null);
      setDropTargetSetId(null);
      return;
    }

    let nextRackLayout = removeRackTiles(draftRackLayout, movingTiles);
    let nextBoard = draftBoard
      .map((set) => ({
        ...set,
        tileIds: normalizeSetTileIds(
          set.tileIds.filter((id) => !movingTiles.has(id)),
          game.tiles,
        ),
      }))
      .filter((set) => set.tileIds.length > 0);

    if (target.type === "rack") {
      if (movingTileIds.every((tileId) => originalRackTiles.has(tileId))) {
        if (rackAutoSort) {
          nextRackLayout = createRackLayout(
            sortTileIds([...rackTileIds(nextRackLayout), ...movingTileIds], game.tiles, rackSortMode),
          );
        } else if (target.slotIndex !== undefined) {
          nextRackLayout = placeRackTilesAtSlot(draftRackLayout, movingTileIds, target.slotIndex, target.side);
        } else {
          nextRackLayout = reconcileRackLayout(
            nextRackLayout,
            [...rackTileIds(nextRackLayout), ...movingTileIds],
          );
        }
      }
    } else if (target.type === "new") {
      nextBoard.push({
        id: target.setId ?? `draft-${crypto.randomUUID()}`,
        tileIds: normalizeSetTileIds(movingTileIds, game.tiles),
      });
    } else {
      const targetIndex = nextBoard.findIndex((set) => set.id === target.setId);
      if (targetIndex < 0) return;
      const set = nextBoard[targetIndex]!;
      nextBoard[targetIndex] = {
        ...set,
        tileIds: normalizeSetTileIds([...set.tileIds, ...movingTileIds], game.tiles),
      };
    }

    const destination = target.type === "rack"
      ? "your rack"
      : target.type === "new"
        ? "a new set"
        : `set ${feltSetNumber(target.setId)}`;
    setInteractionAnnouncement(`Moved ${movingTileIds.length} ${movingTileIds.length === 1 ? "tile" : "tiles"} to ${destination}.`);
    recordDraft(nextBoard, nextRackLayout);
  }

  function mergeSets(sourceSetId: string, targetSetId: string) {
    if (!isMyTurn || !game || sourceSetId === targetSetId) {
      setDraggedItem(null);
      setDropTargetSetId(null);
      return;
    }
    const source = draftBoard.find((set) => set.id === sourceSetId);
    const target = draftBoard.find((set) => set.id === targetSetId);
    if (!source || !target) return;

    const nextBoard = draftBoard
      .filter((set) => set.id !== sourceSetId)
      .map((set) => set.id === targetSetId
        ? {
            ...set,
            tileIds: normalizeSetTileIds([...set.tileIds, ...source.tileIds], game.tiles),
          }
        : set);
    setInteractionAnnouncement("Combined the two sets.");
    recordDraft(nextBoard, draftRackLayout);
  }

  function handleTileClick(event: ReactMouseEvent<HTMLButtonElement>, tileId: string) {
    if (!isMyTurn) return;
    if (suppressTileClick.current === tileId) {
      suppressTileClick.current = null;
      return;
    }
    if (event.shiftKey) {
      selectTileRange(tileId);
      return;
    }
    toggleTileSelection(tileId);
  }

  function depositSelectedTilesIntoSet(setId: string) {
    if (selectedTileIds.length === 0) return;
    moveTiles(selectedTileIds, { type: "set", setId });
  }

  function selectWholeSet(set: GameSet) {
    selectionAnchorId.current = set.tileIds[0] ?? null;
    setSelectedTileIds(set.tileIds);
    setDraggedItem(null);
    setInteractionAnnouncement(`Set ${feltSetNumber(set.id)} selected. ${set.tileIds.length} tiles picked up.`);
  }

  function handleSetKeyDown(
    event: ReactKeyboardEvent<HTMLDivElement>,
    set: GameSet,
  ) {
    if (!isMyTurn) return;
    const isSetSurfaceTarget = event.target === event.currentTarget
      || (event.target instanceof HTMLElement && event.target.classList.contains("set-drag-handle"));
    if (!isSetSurfaceTarget) return;
    setKeyboardNavigationActive(true);
    setFocusedSetId(set.id);

    if (!event.metaKey && !event.ctrlKey && (event.key === " " || event.key === "Spacebar")) {
      event.preventDefault();
      selectWholeSet(set);
      return;
    }

    if (!event.shiftKey && !event.metaKey && !event.ctrlKey && event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      depositSelectedTilesIntoSet(set.id);
      return;
    }

    const navigationKeys = ["ArrowDown", "ArrowLeft", "ArrowRight", "ArrowUp"] as const;
    if (navigationKeys.includes(event.key as typeof navigationKeys[number])) {
      event.preventDefault();
      const key = event.key as typeof navigationKeys[number];
      const horizontal = key === "ArrowLeft" || key === "ArrowRight";
      const moveBetweenSets = !horizontal || event.shiftKey;
      if (moveBetweenSets) {
        const nextSet = directionalSet(event.currentTarget, key)
          ?? (!horizontal ? verticalWrapTarget(event.currentTarget, key) : null);
        if (nextSet) nextSet.focus();
        return;
      }

      const next = horizontalSetSequenceTarget(event.currentTarget, key);
      if (next) next.focus();
    }
  }

  function handleTileKeyDown(
    event: ReactKeyboardEvent<HTMLButtonElement>,
    tileId: string,
  ) {
    if (!isMyTurn) return;
    setKeyboardNavigationActive(true);
    setFocusedTileId(tileId);

    if (event.altKey && !event.metaKey && !event.ctrlKey && event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      moveTiles(
        selectedTileIds.length > 0 ? selectedTileIds : [tileId],
        { type: "new" },
      );
      return;
    }

    if (event.shiftKey && !event.metaKey && !event.ctrlKey && event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      const tileIds = draftRack.includes(tileId)
        ? rackAutoSort
          ? findLinkedRackTileIds(draftRack, tileId, game?.tiles ?? {})
          : [tileId]
        : tileSequence(tileId);
      selectionAnchorId.current = tileId;
      setSelectedTileIds(tileIds);
      setDraggedItem(null);
      announceSelection(tileIds, tileId);
      return;
    }

    if (!event.shiftKey && !event.metaKey && !event.ctrlKey && event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      const set = draftBoard.find((candidate) => candidate.tileIds.includes(tileId));
      if (set) depositSelectedTilesIntoSet(set.id);
      return;
    }

    if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === "a") {
      event.preventDefault();
      event.stopPropagation();
      const tileIds = tileSequence(tileId);
      selectionAnchorId.current = tileId;
      setSelectedTileIds(tileIds);
      setDraggedItem(null);
      announceSelection(tileIds, tileId);
      return;
    }

    if (event.key === " " || event.key === "Spacebar") {
      event.preventDefault();
      if (event.shiftKey) selectTileRange(tileId);
      else toggleTileSelection(tileId);
      return;
    }

    const navigationKeys = ["ArrowDown", "ArrowLeft", "ArrowRight", "ArrowUp"] as const;
    if (navigationKeys.includes(event.key as typeof navigationKeys[number])) {
      event.preventDefault();
      const key = event.key as typeof navigationKeys[number];
      const inSet = Boolean(event.currentTarget.closest(".set-tiles"));
      const horizontal = key === "ArrowLeft" || key === "ArrowRight";

      let next = directionalTile(event.currentTarget, key, event.shiftKey);
      if (!next) {
        next = key === "ArrowUp" || key === "ArrowDown"
          ? verticalWrapTarget(event.currentTarget, key)
          : null;
      }
      if (!next) return;
      const nextTileId = next.dataset.tileId;
      if (event.shiftKey && nextTileId && !(inSet && horizontal)) extendSelectionTo(tileId, nextTileId);
      next.focus();
      return;
    }

    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const root = event.metaKey || event.ctrlKey
        ? event.currentTarget.closest(".game-shell")
        : event.currentTarget.closest(".set-tiles, .rack-level");
      if (!root) return;
      const candidates = tileButtons(root);
      const next = event.key === "Home" ? candidates[0] : candidates.at(-1);
      if (!next) return;
      const nextTileId = next.dataset.tileId;
      if (event.shiftKey && nextTileId) extendSelectionTo(tileId, nextTileId);
      next.focus();
    }
  }

  function pickUpOrMergeSet(setId: string) {
    if (!isMyTurn) return;
    if (draggedItem?.type === "set") {
      if (draggedItem.setId === setId) {
        setDraggedItem(null);
        setInteractionAnnouncement("Set move canceled.");
      } else {
        mergeSets(draggedItem.setId, setId);
      }
      return;
    }
    setSelectedTileIds([]);
    selectionAnchorId.current = null;
    setDraggedItem({ type: "set", setId });
    const setNumber = feltSetNumber(setId);
    setInteractionAnnouncement(`Picked up set ${setNumber}. Choose another set's move button to combine them, or press Escape to cancel.`);
  }

  function handleRackTileDoubleClick(tileId: string) {
    if (!isMyTurn || !game) return;
    cancelRackHold();

    const activeSetId = doubleClickSetId.current;
    if (activeSetId && draftBoard.some((set) => set.id === activeSetId)) {
      moveTiles([tileId], { type: "set", setId: activeSetId });
      return;
    }

    const setId = `draft-${crypto.randomUUID()}`;
    doubleClickSetId.current = setId;
    moveTiles([tileId], { type: "new", setId });
  }

  function dragTileStart(event: DragEvent<HTMLButtonElement>, tileId: string) {
    event.stopPropagation();
    cancelRackHold();
    const tileIds = selectedTileIds.length > 1 && selectedTileIds.includes(tileId)
      ? selectedTileIds
      : [tileId];
    const item: DragItem = { type: "tiles", tileIds };
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(DRAG_ITEM_TYPE, JSON.stringify(item));
    event.dataTransfer.setData("text/tile-id", tileId);
    event.dataTransfer.setData("text/tile-ids", JSON.stringify(tileIds));
    tileDragPreview.current?.remove();
    tileDragPreview.current = null;
    if (typeof event.dataTransfer.setDragImage === "function") {
      const tileStyle = getComputedStyle(event.currentTarget);
      let preview: HTMLElement;
      let offsetX: number;
      let offsetY: number;

      if (tileIds.length > 1) {
        preview = createMultiTileDragPreview(tileStyle);
        offsetX = 29;
        offsetY = 38;
      } else {
        // Felt tiles are inside a scaled set. Cloning the tile into the body
        // gives the browser an untransformed drag image, just like the rack.
        const tilePreview = event.currentTarget.cloneNode(true) as HTMLButtonElement;
        tilePreview.classList.remove("is-selected", "is-new-activity");
        tilePreview.setAttribute("aria-hidden", "true");
        tilePreview.tabIndex = -1;
        tilePreview.style.position = "fixed";
        tilePreview.style.top = "-1000px";
        tilePreview.style.left = "-1000px";
        tilePreview.style.margin = "0";
        tilePreview.style.transform = "none";
        tilePreview.style.width = tileStyle.width;
        tilePreview.style.height = tileStyle.height;
        for (let index = 0; index < tileStyle.length; index += 1) {
          const property = tileStyle[index];
          if (property?.startsWith("--tile-")) {
            tilePreview.style.setProperty(property, tileStyle.getPropertyValue(property));
          }
        }
        preview = tilePreview;
        offsetX = Number.parseFloat(tileStyle.width) / 2;
        offsetY = Number.parseFloat(tileStyle.height) / 2;
      }

      document.body.append(preview);
      event.dataTransfer.setDragImage(preview, offsetX, offsetY);
      tileDragPreview.current = preview;
    }
    setSelectedTileIds(tileIds);
    setDraggedItem(item);
  }

  function createMultiTileDragPreview(tileStyle: CSSStyleDeclaration): HTMLElement {
    const preview = document.createElement("span");
    preview.className = "tile-drag-preview";
    const backTile = document.createElement("span");
    backTile.className = "tile-drag-preview-tile tile-drag-preview-tile-back";
    const frontTile = document.createElement("span");
    frontTile.className = "tile-drag-preview-tile tile-drag-preview-tile-front";
    preview.append(backTile, frontTile);
    for (const property of ["--tile-face", "--tile-edge", "--tile-border-width", "--tile-radius", "--tile-sheen"]) {
      preview.style.setProperty(property, tileStyle.getPropertyValue(property));
    }
    return preview;
  }

  function beginRackHold(event: ReactPointerEvent<HTMLButtonElement>, tileId: string) {
    if (!game || !isMyTurn || !event.isPrimary || (event.pointerType === "mouse" && event.button !== 0)) return;
    cancelRackHold();
    const heldIndex = draftRack.indexOf(tileId);
    if (heldIndex < 0) return;

    const holdRun = rackHoldRun.current;
    const tileIdsToPickUp = draftRack.slice(heldIndex);
    const pointerTarget = event.currentTarget;
    const pointerId = event.pointerId;
    rackHoldPointerId.current = pointerId;
    const pickUpNextTile = (index: number) => {
      rackHoldTimer.current = window.setTimeout(() => {
        if (holdRun !== rackHoldRun.current) return;
        const pickedUpTileIds = tileIdsToPickUp.slice(0, index + 1);
        if (index === 0) {
          try {
            pointerTarget.setPointerCapture(pointerId);
          } catch {
            // Synthetic pointer events do not have an active pointer to capture.
          }
          suppressTileClick.current = tileId;
          selectionAnchorId.current = tileId;
          setDraggedItem(null);
        }
        setSelectedTileIds(pickedUpTileIds);
        announceSelection(pickedUpTileIds, tileIdsToPickUp[index]);

        const nextIndex = index + 1;
        if (nextIndex < tileIdsToPickUp.length) pickUpNextTile(nextIndex);
        else rackHoldTimer.current = null;
      }, index === 0 ? RACK_HOLD_MS : RACK_HOLD_REPEAT_MS);
    };

    pickUpNextTile(0);
  }

  function cancelRackHold() {
    rackHoldRun.current += 1;
    rackHoldPointerId.current = null;
    if (rackHoldTimer.current !== null) {
      window.clearTimeout(rackHoldTimer.current);
      rackHoldTimer.current = null;
    }
  }

  function dragSetStart(event: DragEvent<HTMLDivElement>, setId: string) {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(DRAG_ITEM_TYPE, JSON.stringify({ type: "set", setId }));
    event.dataTransfer.setData("text/set-id", setId);
    tileDragPreview.current?.remove();
    tileDragPreview.current = null;
    if (typeof event.dataTransfer.setDragImage === "function") {
      const preview = createMultiTileDragPreview(getComputedStyle(event.currentTarget));
      document.body.append(preview);
      event.dataTransfer.setDragImage(preview, 29, 38);
      tileDragPreview.current = preview;
    }
    setSelectedTileIds([]);
    setDraggedItem({ type: "set", setId });
  }

  function readDragItem(event: DragEvent<HTMLElement>): DragItem | null {
    const encoded = event.dataTransfer.getData(DRAG_ITEM_TYPE);
    if (encoded) {
      try {
        const item = JSON.parse(encoded) as DragItem;
        if (item.type === "tiles" && Array.isArray(item.tileIds) && item.tileIds.every((id) => typeof id === "string")) return item;
        if (item.type === "set" && item.setId) return item;
      } catch {
        // Fall through to the broadly supported plain-text transfer types.
      }
    }
    const setId = event.dataTransfer.getData("text/set-id");
    if (setId) return { type: "set", setId };
    const encodedTileIds = event.dataTransfer.getData("text/tile-ids");
    if (encodedTileIds) {
      try {
        const tileIds = JSON.parse(encodedTileIds) as unknown;
        if (Array.isArray(tileIds) && tileIds.every((id) => typeof id === "string")) {
          return { type: "tiles", tileIds };
        }
      } catch {
        // Fall through to the single-tile transfer type.
      }
    }
    const tileId = event.dataTransfer.getData("text/tile-id");
    if (tileId) return { type: "tiles", tileIds: [tileId] };
    return draggedItem ?? (selectedTileIds.length > 0 ? { type: "tiles", tileIds: selectedTileIds } : null);
  }

  function rackDropSideForEvent(event: DragEvent<HTMLElement>): RackDropSide | undefined {
    // Synthetic drag events used by keyboard/test tooling do not have a
    // pointer position. Keep their legacy direct-slot behavior; real drops
    // use the half of the tile the pointer is over.
    if (!Number.isFinite(event.clientX) || event.clientX <= 0) return undefined;
    return rackDropSideForElement(event.currentTarget, event.clientX);
  }

  function rackDropSideForElement(element: HTMLElement, clientX: number): RackDropSide {
    const bounds = element.getBoundingClientRect();
    return clientX < bounds.left + bounds.width / 2 ? "before" : "after";
  }

  function rackSlotAtPoint(rack: HTMLElement, clientX: number, clientY: number): HTMLElement | null {
    const slots = [...rack.querySelectorAll<HTMLElement>(".rack-slot")];
    const directHit = slots.find((slot) => {
      const bounds = slot.getBoundingClientRect();
      return clientX >= bounds.left && clientX <= bounds.right && clientY >= bounds.top && clientY <= bounds.bottom;
    });
    if (directHit) return directHit;

    // The rack itself remains a drop surface in the gaps between slots. Map
    // those pixels to the nearest fixed slot so a transparent slot can never
    // become an accidental dead zone.
    return slots
      .map((slot) => {
        const bounds = slot.getBoundingClientRect();
        const dx = clientX < bounds.left ? bounds.left - clientX : clientX > bounds.right ? clientX - bounds.right : 0;
        const dy = clientY < bounds.top ? bounds.top - clientY : clientY > bounds.bottom ? clientY - bounds.bottom : 0;
        return { slot, distance: dx * dx + dy * dy };
      })
      .sort((left, right) => left.distance - right.distance)[0]?.slot ?? null;
  }

  function drop(event: DragEvent<HTMLElement>, target: MoveTarget) {
    event.preventDefault();
    const item = readDragItem(event);
    if (!item) return;
    if (item.type === "tiles") {
      const rackTarget = target.type === "rack" && target.slotIndex !== undefined
        ? {
            ...target,
            side: target.side
              ?? rackDropSideForEvent(event)
              ?? (rackDropTarget?.slotIndex === target.slotIndex ? rackDropTarget.side : undefined),
          }
        : target;
      moveTiles(item.tileIds, rackTarget);
    } else if (target.type === "set") {
      mergeSets(item.setId, target.setId);
    } else if (target.type === "rack") {
      setError("A whole set cannot move to your rack. Drag an eligible rack tile instead.");
      setDraggedItem(null);
      setRackDropTarget(null);
      setDropTargetSetId(null);
    } else {
      setDraggedItem(null);
      setDropTargetSetId(null);
    }
  }

  function finishDrag() {
    tileDragPreview.current?.remove();
    tileDragPreview.current = null;
    setDraggedItem(null);
    setRackDropTarget(null);
    setDropTargetSetId(null);
  }

  function resetDraft() {
    showTurnHistory(0);
  }

  function changeRackSort(nextMode: TileSortMode) {
    setRackSortMode(nextMode);
    setRackAutoSort(true);
    localStorage.setItem("guppycube:rack-sort", nextMode);
    localStorage.setItem(RACK_AUTOSORT_PREFERENCE_KEY, "true");
    if (game) {
      setDraftRackLayout(createRackLayout(
        sortTileIds(draftRack, game.tiles, nextMode),
      ));
      setTurnHistory((history) => history.map((draft) => ({
        ...draft,
        rackLayout: createRackLayout(
          sortTileIds(rackTileIds(draft.rackLayout), game.tiles, nextMode),
        ),
      })));
      clearTurnInteraction();
    }
  }

  async function runAction(action: Parameters<typeof takeAction>[1]) {
    setBusy(true);
    setError("");
    try {
      await takeAction(session, action);
      clearTurnInteraction();
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That action did not work.");
    } finally {
      setBusy(false);
    }
  }

  async function beginGame() {
    setBusy(true);
    setError("");
    try {
      await startGame(session);
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not start the game.");
    } finally {
      setBusy(false);
    }
  }

  async function addComputerPlayer() {
    setBusy(true);
    setError("");
    try {
      await addComputer(session, computerStrategy);
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not add the computer player.");
    } finally {
      setBusy(false);
    }
  }

  async function changeAssist(assistId: AssistId, enabled: boolean) {
    setBusy(true);
    setError("");
    try {
      await setAssist(session, { assistId, enabled });
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not update that assist.");
    } finally {
      setBusy(false);
    }
  }

  async function copyInvite() {
    let invite = portableLink;
    if (!invite) {
      try {
        invite = (await getPlayerLink(session)).link;
        setPortableLink(invite);
      } catch {
        invite = window.location.href;
      }
    }
    try {
      await navigator.clipboard.writeText(invite);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_600);
    } catch {
      setError(`Share this link: ${invite}`);
    }
  }

  function changeColorTheme(next: string) {
    const theme = colorThemeById(next);
    setColorThemeId(theme.id);
    localStorage.setItem(COLOR_THEME_PREFERENCE_KEY, theme.id);
  }

  function changeTileTheme(next: string) {
    const theme = tileThemeById(next);
    setTileThemeId(theme.id);
    localStorage.setItem(TILE_THEME_PREFERENCE_KEY, theme.id);
  }

  async function changeTurnNotifications(enabled: boolean) {
    if (!enabled) {
      setTurnNotificationsEnabled(false);
      localStorage.setItem(TURN_NOTIFICATIONS_PREFERENCE_KEY, "false");
      return;
    }

    if (notificationPermission === "unsupported") return;
    let permission: NotificationPermission;
    try {
      permission = notificationPermission === "default"
        ? await Notification.requestPermission()
        : notificationPermission;
    } catch {
      return;
    }
    setNotificationPermission(permission);
    const allowed = permission === "granted";
    setTurnNotificationsEnabled(allowed);
    localStorage.setItem(TURN_NOTIFICATIONS_PREFERENCE_KEY, String(allowed));
  }

  function drawAndEnd() {
    if (!isMyTurn || busy) return;
    const poolEmpty = game.poolCount === 0;
    if (dirty && !window.confirm(`Discard your table changes and ${poolEmpty ? "pass" : "draw a tile"}?`)) return;
    setInteractionAnnouncement(poolEmpty ? "Passing because the pool is empty." : "Drawing a tile and ending your turn.");
    void runAction({ type: "draw" });
  }

  function commitTurn() {
    if (!isMyTurn || busy) return;
    if (!canCommit) {
      setInteractionAnnouncement(`Turn not ready. ${turnValidation?.reason ?? "Finish a valid play before submitting."}`);
      return;
    }
    setInteractionAnnouncement("Submitting your turn.");
    void runAction({ type: "commit", board: draftBoard });
  }

  function handleTurnShortcut(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.defaultPrevented || event.repeat || isShortcutTypingTarget(event.target, event)) return;

    if (event.altKey && !event.metaKey && !event.ctrlKey && event.key === "Enter" && isMyTurn && !busy) {
      const tileId = tileIdFromEventTarget(event.target);
      const tileIds = selectedTileIds.length > 0
        ? selectedTileIds
        : tileId
          ? [tileId]
          : [];
      if (tileIds.length === 0) return;
      event.preventDefault();
      event.stopPropagation();
      moveTiles(tileIds, { type: "new" });
      return;
    }

    const primaryModifier = event.metaKey || event.ctrlKey;
    if (!primaryModifier || event.altKey || !isMyTurn || busy) return;

    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      if (event.shiftKey) drawAndEnd();
      else commitTurn();
    }
  }

  function handleGameShortcut(event: KeyboardEvent) {
    if (event.defaultPrevented || event.repeat || isShortcutTypingTarget(event.target, event)) return;

    if (event.altKey && !event.metaKey && !event.ctrlKey && event.key === "Enter" && isMyTurn && !busy) {
      const tileId = tileIdFromEventTarget(event.target);
      const tileIds = selectedTileIds.length > 0
        ? selectedTileIds
        : tileId
          ? [tileId]
          : [];
      if (tileIds.length === 0) return;
      event.preventDefault();
      moveTiles(tileIds, { type: "new" });
      return;
    }

    const navigationKeys = ["ArrowDown", "ArrowLeft", "ArrowRight", "ArrowUp"] as const;
    const isTileTarget = event.target instanceof HTMLElement && Boolean(event.target.closest(ENABLED_TILE_SELECTOR));
    if (
      isMyTurn
      && !isTileTarget
      && !event.metaKey
      && !event.ctrlKey
      && !event.altKey
      && navigationKeys.includes(event.key as typeof navigationKeys[number])
    ) {
      event.preventDefault();
      focusTileNavigation(event.key as typeof navigationKeys[number]);
      return;
    }

    if (event.key === "Escape" && (selectedTileIds.length > 0 || draggedItem)) {
      event.preventDefault();
      clearTurnInteraction();
      setInteractionAnnouncement("Selection canceled.");
      return;
    }

    const primaryModifier = event.metaKey || event.ctrlKey;
    if (!primaryModifier || event.altKey || !isMyTurn || busy) return;

    if (event.key === "Enter") {
      event.preventDefault();
      if (event.shiftKey) drawAndEnd();
      else commitTurn();
      return;
    }

    if (event.shiftKey && event.key === "Backspace" && turnHistoryIndex > 0) {
      event.preventDefault();
      resetDraft();
      setInteractionAnnouncement("Turn reset.");
      return;
    }

    const key = event.key.toLocaleLowerCase();
    const wantsUndo = key === "z" && !event.shiftKey;
    const wantsRedo = key === "y" || (key === "z" && event.shiftKey);
    if (wantsUndo && turnHistoryIndex > 0) {
      event.preventDefault();
      showTurnHistory(turnHistoryIndex - 1);
      setInteractionAnnouncement("Undid the last table move.");
    } else if (wantsRedo && turnHistoryIndex < turnHistory.length - 1) {
      event.preventDefault();
      showTurnHistory(turnHistoryIndex + 1);
      setInteractionAnnouncement("Redid the next table move.");
    }
  }

  gameShortcutRef.current = handleGameShortcut;
  useEffect(() => {
    const handleWindowKeyDown = (event: KeyboardEvent) => gameShortcutRef.current(event);
    window.addEventListener("keydown", handleWindowKeyDown);
    return () => window.removeEventListener("keydown", handleWindowKeyDown);
  }, []);

  if (!game) {
    return (
      <main className="loading-screen">
        <div className="loading-mark"><span /><span /><span /></div>
        <h1>Setting the table…</h1>
        {error && <><p>{error}</p><button className="secondary-button" onClick={onExit}>Back home</button></>}
      </main>
    );
  }

  if (game.status === "lobby") {
    const isHost = game.players.some((player) => player.id === game.myPlayerId && player.isHost);
    return (
      <main className={`lobby-shell ${activeColorTheme.className} ${activeTileTheme.className}`}>
        <nav className="game-nav">
          <button className="wordmark wordmark-button" type="button" onClick={onExit} aria-label="guppycube home"><span><CatFaceIcon className="wordmark-cat" /></span> guppycube</button>
          <button className="icon-button" type="button" onClick={onShowRules} aria-label="How to play"><HelpCircle /></button>
        </nav>
        <section className="lobby-card">
          <p className="eyebrow">Your table is ready</p>
          <h1>Bring in the<br />competition.</h1>
          <button className="invite-code" type="button" onClick={copyInvite}>
            <span>Table name</span><strong>{game.id}</strong><small>{copied ? <><Check size={15} /> Copied your player link</> : <><Copy size={15} /> Click to copy your player link</>}</small>
          </button>
          <div className="lobby-seats">
            {Array.from({ length: game.maxPlayers }, (_, index) => {
              const player = game.players[index];
              return player ? (
                <div className={`seat is-filled ${player.isComputer ? "is-computer" : ""}`} key={player.id}><span>{player.isComputer ? <Bot size={20} /> : initials(player.name)}</span><div><strong>{player.name}</strong><small>{player.isHost ? "Host" : player.isComputer ? `Computer · ${player.computerStrategy ?? "basic"}` : "Ready"}</small></div>{player.isComputer ? <Bot size={18} /> : <Check size={18} />}</div>
              ) : (
                <div className="seat" key={index}><span><Plus /></span><div><strong>Open seat</strong><small>Waiting for a friend</small></div></div>
              );
            })}
          </div>
          {isHost && game.players.length < game.maxPlayers && (
            <div className="computer-controls">
              <label htmlFor="computer-strategy">Computer strategy</label>
              <select
                id="computer-strategy"
                value={computerStrategy}
                disabled={busy}
                onChange={(event) => setComputerStrategy(event.target.value as ComputerStrategyId)}
              >
                <option value="basic">Basic</option>
              </select>
              <button className="secondary-button" type="button" disabled={busy} onClick={addComputerPlayer}><Bot /> Add computer</button>
            </div>
          )}
          <section className="lobby-assists" aria-label="Your assists">
            <div className="lobby-assists-heading"><SlidersHorizontal /><span><strong>Your assists</strong><small>Each player chooses from the modes allowed by the host.</small></span></div>
            <AssistControls game={game} busy={busy} onToggle={(assistId, enabled) => void changeAssist(assistId, enabled)} />
          </section>
          <div className="lobby-meta"><span><Clock3 size={17} /> {game.mode === "realtime" ? "1-minute turns" : "72-hour turns"}</span><span><Users size={17} /> {game.players.length} of {game.maxPlayers}</span></div>
          {error && <p className="form-error" role="alert">{error}</p>}
          {isHost ? (
            <button className="primary-button lobby-start" type="button" disabled={busy || game.players.length < 2} onClick={beginGame}>{busy ? "Shuffling…" : game.players.length < 2 ? "Waiting for one more player" : "Shuffle & start"}</button>
          ) : <p className="waiting-copy">Waiting for the host to start the game…</p>}
        </section>
      </main>
    );
  }

  const players = game.players;
  const computerPlayerIds = players
    .filter((player) => player.id !== game.myPlayerId && player.isComputer)
    .map((player) => player.id);
  const toggleComputerRack = (playerId: string) => {
    setOpenComputerRackIds((current) => {
      const next = new Set(current.includes(ALL_COMPUTER_RACKS) ? computerPlayerIds : current);
      if (next.has(playerId)) next.delete(playerId);
      else next.add(playerId);
      return [...next];
    });
  };
  const lastTurnByPlayer = new Map<string, GameEvent>();
  for (const item of game.history) {
    if (item.playerId !== null && TURN_EVENT_KINDS.has(item.kind)) lastTurnByPlayer.set(item.playerId, item);
  }
  const newActivityTiles = new Set(newActivityTileIds);
  const newActivitySets = new Set(
    draftBoard
      .filter((set) => set.tileIds.some((tileId) => newActivityTiles.has(tileId)))
      .map((set) => set.id),
  );
  const setsById = new Map(draftBoard.map((set) => [set.id, set]));

  return (
    <main
      className={`game-shell ${activeColorTheme.className} ${activeTileTheme.className} ${keyboardNavigationActive ? "is-keyboard-navigating" : ""}`}
      onKeyDownCapture={handleTurnShortcut}
    >
      <p className="sr-only" aria-live="polite" aria-atomic="true">{interactionAnnouncement}</p>
      <header className="game-header">
        <button className="wordmark wordmark-button compact-mark" type="button" onClick={onExit} aria-label="guppycube home"><span><CatFaceIcon className="wordmark-cat" /></span><b>guppycube</b></button>
        <div className="room-pill"><span>TABLE</span> <strong>{game.id}</strong><button className="room-copy-button" type="button" onClick={copyInvite} aria-label={copied ? "Player link copied" : "Copy your player link"} title={copied ? "Player link copied" : "Copy your player link"}>{copied ? <Check /> : <Copy />}</button></div>
        <div className="header-actions">
          <span className={`connection-pill is-${connection}`}>{connection === "online" ? <Wifi /> : <WifiOff />} {connection}</span>
          <button className={`icon-button ${turnNotificationsEnabled && notificationPermission === "granted" ? "is-active" : ""}`} type="button" aria-pressed={showNotifications} onClick={() => { setShowNotifications(!showNotifications); setShowAppearance(false); setShowAssists(false); setShowActivity(false); }} aria-label="Turn notifications"><Bell /></button>
          <button className="icon-button" type="button" aria-pressed={showAppearance} onClick={() => { setShowAppearance(!showAppearance); setShowNotifications(false); setShowAssists(false); setShowActivity(false); }} aria-label="Appearance"><Palette /></button>
          <button className="icon-button" type="button" aria-pressed={showAssists} onClick={() => { setShowAssists(!showAssists); setShowNotifications(false); setShowAppearance(false); setShowActivity(false); }} aria-label="Assists"><SlidersHorizontal /></button>
          <button className="icon-button" type="button" aria-pressed={showActivity} onClick={() => { setShowActivity(!showActivity); setShowNotifications(false); setShowAppearance(false); setShowAssists(false); }} aria-label="Activity"><History /></button>
          <button className="icon-button" type="button" onClick={onShowRules} aria-label="How to play and keyboard controls"><HelpCircle /></button>
          <button className="icon-button desktop-only" type="button" onClick={onExit} aria-label="Leave table"><LogOut /></button>
        </div>
      </header>

      <section className="players-strip" aria-label="Players">
        {players.map((player) => {
          const lastTurn = lastTurnByPlayer.get(player.id);
          const lastTurnSummary = lastTurn ? turnActionSummary(lastTurn, player.name) : null;
          const isFlashing = flashedAction?.playerId === player.id;
          const isMe = player.id === game.myPlayerId;
          const isOnClock = player.id === game.currentPlayerId;
          const isComputerRackOpen = player.isComputer
            && !isMe
            && (openComputerRackIds.includes(ALL_COMPUTER_RACKS) || openComputerRackIds.includes(player.id));
          return (
            <article
              className={`player-card ${player.isComputer ? "is-computer" : ""} ${isComputerRackOpen ? "is-rack-open" : ""} ${isMe ? "is-me" : ""} ${isOnClock ? "is-turn" : ""} ${lastTurn ? "has-last-turn" : ""} ${isFlashing ? "has-action-flash" : ""}`}
              key={player.id}
              aria-current={isOnClock ? "true" : undefined}
              tabIndex={lastTurn ? 0 : undefined}
              title={lastTurn ? `Last turn: ${lastTurn.message}` : undefined}
            >
              <div className="avatar">{initials(player.name)}<i className={player.connected ? "is-online" : ""} /></div>
              <div className="player-card-copy">
                <strong><span className="player-name">{player.name}</span>{isMe && <span className="you-badge">You</span>}</strong>
                <small className={`player-status ${isOnClock ? "is-on-clock" : ""}`}>
                  {isOnClock ? <><Clock3 aria-hidden="true" /> On the clock</> : player.isComputer ? `Computer · ${player.computerStrategy ?? "basic"}` : player.opened ? "On the table" : "Needs 30"}
                </small>
                {lastTurnSummary && <small className="player-last-turn">Last: {lastTurnSummary}</small>}
              </div>
              <div className="mini-rack"><Layers3 size={15} /><b>{player.rackCount}</b></div>
              {player.isComputer && !isMe && (
                <button
                  className={`computer-rack-toggle ${isComputerRackOpen ? "is-active" : ""}`}
                  type="button"
                  aria-label={`${isComputerRackOpen ? "Hide" : "Show"} ${player.name}'s rack`}
                  aria-pressed={isComputerRackOpen}
                  onClick={() => toggleComputerRack(player.id)}
                >
                  {isComputerRackOpen ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
                </button>
              )}
              {isComputerRackOpen && (
                <section className="computer-rack-inline" aria-label={`${player.name}'s rack`}>
                  <small>{player.rackCount} visible tiles</small>
                  <div className="computer-rack-tiles">
                    {sortTileIds(player.rackTileIds, game.tiles, rackSortMode).map((tileId) => {
                      const tile = game.tiles[tileId];
                      return tile ? <TileView compact disabled key={tileId} tile={tile} /> : null;
                    })}
                  </div>
                </section>
              )}
              {isFlashing && (
                <span className={`player-action-flash kind-${flashedAction.kind}`} role="status" aria-label={flashedAction.message}>
                  <Sparkles aria-hidden="true" />
                  <b>{turnActionSummary(flashedAction, player.name)}</b>
                </span>
              )}
            </article>
          );
        })}
        <div className="players-topline-actions">
          <div className={`turn-clock ${isMyTurn ? "is-mine" : ""}`}><Clock3 /><span><small>{isMyTurn ? "Your turn" : `${currentPlayer?.name ?? "—"}'s turn`}</small><strong>{timeLabel(game.turnDeadline, now)}</strong></span></div>
        </div>
      </section>

      <div className="table-layout">
        <section
          className={`table-surface ${isMyTurn ? "is-open-drop-target" : ""} ${hasLiveOpponentDraft ? "is-watching-live" : ""} ${hasBoardDefect ? "has-board-defect" : ""} ${selectedTileIds.length > 0 || draggedItem ? "has-selected-tile" : ""}`}
          aria-label={`Game table${hasLiveOpponentDraft ? `, live attempt by ${currentPlayer?.name ?? "the current player"}` : ""}${hasBoardDefect && visibleTurnValidation?.reason ? `. Needs attention: ${visibleTurnValidation.reason}` : ""}`}
          onClick={() => selectedTileIds.length > 0 && moveTiles(selectedTileIds, { type: "new" })}
          onDragOver={(event) => {
            if (!isMyTurn) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
          }}
          onDrop={(event) => drop(event, { type: "new" })}
        >
          <button
            className="pool-count"
            ref={poolRef}
            type="button"
            disabled={!isMyTurn || busy}
            aria-label={game.poolCount === 0
              ? `Pass because the pool is empty and end your turn.`
              : `Draw one tile and end turn. ${game.poolCount} tiles remain in the pool.`}
            title={isMyTurn
              ? game.poolCount === 0 ? "Pass because the pool is empty" : "Draw one tile and end your turn"
              : `${currentPlayer?.name ?? "Another player"} is drawing`}
            onClick={(event) => {
              event.stopPropagation();
              drawAndEnd();
            }}
          ><span className="tile-stack-icon" aria-hidden="true" /><span><small>{game.poolCount === 0 ? "Empty pool" : "Draw pile"}</small><strong>{game.poolCount}</strong></span></button>

          <div className="sets" ref={feltRef}>
            {feltLayout.placements.length > 0 && (
              <div
                className="set-grid"
                data-felt-rows={feltLayout.rowCount}
                data-felt-scale={feltLayout.scale.toFixed(2)}
              >
                {feltLayout.placements.map((placement) => {
                  const set = setsById.get(placement.id);
                  if (!set) return null;
                  const setIndex = placement.order;
                  const validation = validateSet(set.tileIds, game.tiles);
                  const wilcardAssignments = resolveWilcardAssignments(set.tileIds, game.tiles);
                  return (
                    <div
                      className={`set ${validation.valid ? "is-valid" : "is-invalid"} ${draftChangedSetIds.has(set.id) ? "is-changed" : ""} ${focusedSetId === set.id ? "is-keyboard-focused" : ""} ${newActivitySets.has(set.id) ? "is-new-activity" : ""} ${draggedItem?.type === "set" && draggedItem.setId === set.id ? "is-dragging" : ""} ${dropTargetSetId === set.id ? "is-drop-target" : ""}`}
                      key={set.id}
                      data-set-id={set.id}
                      data-felt-row={placement.row + 1}
                      style={{
                        "--felt-x": `${placement.x}px`,
                        "--felt-y": `${placement.y}px`,
                        "--felt-scale": feltLayout.scale,
                        "--felt-set-width": `${placement.width / feltLayout.scale}px`,
                      } as CSSProperties}
                      tabIndex={isMyTurn ? 0 : undefined}
                      role="group"
                      onFocus={(event) => {
                        if (event.target === event.currentTarget) handleSetFocus(set.id);
                      }}
                      onKeyDown={(event) => handleSetKeyDown(event, set)}
                      draggable={isMyTurn}
                      aria-label={`Set ${setIndex + 1}, ${validation.valid ? validation.kind : "unfinished"}.${selectedTileIds.length > 0 ? ` Click to add ${selectedTileIds.length === 1 ? "the selected tile" : `${selectedTileIds.length} selected tiles`}.` : " Drag to merge with another set."}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        if (draggedItem?.type === "set" && draggedItem.setId !== set.id) {
                          mergeSets(draggedItem.setId, set.id);
                          return;
                        }
                        if (selectedTileIds.length > 0 && !(event.target as HTMLElement).closest(".tile")) {
                          moveTiles(selectedTileIds, { type: "set", setId: set.id });
                        }
                      }}
                      onDragStart={(event) => dragSetStart(event, set.id)}
                      onDragEnd={finishDrag}
                      onDragOver={(event) => {
                        if (!isMyTurn) return;
                        event.preventDefault();
                        event.stopPropagation();
                        event.dataTransfer.dropEffect = "move";
                        if (draggedItem?.type !== "set" || draggedItem.setId !== set.id) {
                          setDropTargetSetId(set.id);
                        }
                      }}
                      onDrop={(event) => {
                        event.stopPropagation();
                        drop(event, { type: "set", setId: set.id });
                      }}
                    >
                      <span className="set-number">{String(setIndex + 1).padStart(2, "0")}</span>
                      {isMyTurn && (
                        <button
                          className="set-drag-handle"
                          type="button"
                          aria-pressed={draggedItem?.type === "set" && draggedItem.setId === set.id}
                          aria-label={draggedItem?.type === "set" && draggedItem.setId !== set.id
                            ? `Combine picked-up set with set ${setIndex + 1}`
                            : `${draggedItem?.type === "set" ? "Put down" : "Pick up"} set ${setIndex + 1}`}
                          title="Pick up this whole set; choose another set to combine"
                          onKeyDown={(event) => {
                            if (event.key !== "Enter") return;
                            event.preventDefault();
                            event.stopPropagation();
                            depositSelectedTilesIntoSet(set.id);
                          }}
                          onClick={(event) => {
                            event.stopPropagation();
                            pickUpOrMergeSet(set.id);
                          }}
                        ><GripVertical /></button>
                      )}
                      <div className="set-tiles">
                        {set.tileIds.map((tileId) => {
                          const tile = game.tiles[tileId];
                          if (!tile) return null;
                          return (
                            <TileView
                              key={tileId}
                              tile={tile}
                              wilcardAssignment={wilcardAssignments[tileId]}
                              wilcardOnTable
                              selected={selectedTileIds.includes(tileId)}
                              newActivity={newActivityTiles.has(tileId)}
                              disabled={!isMyTurn}
                              keyShortcuts="Enter Shift+Enter Alt+Enter Control+A Meta+A"
                          onClick={(event) => handleTileClick(event, tileId)}
                          onFocus={() => handleTileFocus(tileId)}
                          onKeyDown={(event) => handleTileKeyDown(event, tileId)}
                              onDragStart={(event) => dragTileStart(event, tileId)}
                              onDragEnd={(event) => { event.stopPropagation(); finishDrag(); }}
                              onDrop={(event) => { event.stopPropagation(); drop(event, { type: "set", setId: set.id }); }}
                            />
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

          </div>
        </section>

        {showActivity && (
          <aside className="activity-panel">
            <div className="activity-heading"><History /><div><span className="eyebrow">Table talk</span><h2>Activity</h2></div></div>
            <ol>{[...game.history].reverse().map((item) => <li key={item.id}><span className={`activity-dot kind-${item.kind}`} /><div><p>{item.message}</p><time>{new Date(item.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</time></div></li>)}</ol>
          </aside>
        )}
        {showNotifications && (
          <aside className="activity-panel notification-panel">
            <div className="activity-heading"><Bell /><div><span className="eyebrow">Your setup</span><h2>Turn alerts</h2></div></div>
            <p className="assist-panel-copy">Get one quiet browser notification when your turn begins while this table is in the background. No reminders.</p>
            <div className="assist-controls notification-controls">
              <label className={notificationPermission === "unsupported" ? "is-disallowed" : ""}>
                <span><strong>Notify me when it’s my turn</strong><small>Only while this table is open in a background tab.</small></span>
                {notificationPermission === "unsupported" ? (
                  <b>Not supported</b>
                ) : (
                  <input
                    type="checkbox"
                    role="switch"
                    aria-label="Notify me when it’s my turn"
                    checked={turnNotificationsEnabled && notificationPermission === "granted"}
                    disabled={notificationPermission === "denied"}
                    onChange={(event) => { void changeTurnNotifications(event.target.checked); }}
                  />
                )}
              </label>
            </div>
            {notificationPermission === "denied" && (
              <p className="notification-note">Notifications are blocked by your browser. Allow them for this site in browser settings, then try again.</p>
            )}
          </aside>
        )}
        {showAssists && (
          <aside className="activity-panel assist-panel">
            <div className="activity-heading"><SlidersHorizontal /><div><span className="eyebrow">Your setup</span><h2>Assists</h2></div></div>
            <p className="assist-panel-copy">These choices are stored with your seat and work even while you are offline.</p>
            <AssistControls game={game} busy={busy} onToggle={(assistId, enabled) => void changeAssist(assistId, enabled)} />
          </aside>
        )}
        {showAppearance && (
          <aside className="activity-panel appearance-panel">
            <div className="activity-heading"><Palette /><div><span className="eyebrow">Your setup</span><h2>Appearance</h2></div></div>
            <p className="appearance-panel-copy">Mix any room color with any tile set. Your choices stay on this device.</p>
            <fieldset className="appearance-group">
              <legend>Room color</legend>
              <div className="appearance-options">
                {COLOR_THEMES.map((theme) => (
                  <label className={`appearance-choice ${theme.className}`} key={theme.id}>
                    <input
                      type="radio"
                      name="color-theme"
                      value={theme.id}
                      checked={colorThemeId === theme.id}
                      onChange={(event) => changeColorTheme(event.target.value)}
                    />
                    <span className="appearance-color-preview" aria-hidden="true"><i /><i /><i /></span>
                    <span><strong>{theme.name}</strong><small>{theme.note}</small></span>
                  </label>
                ))}
              </div>
            </fieldset>
            <fieldset className="appearance-group">
              <legend>Tile set</legend>
              <div className="appearance-options">
                {TILE_THEMES.map((theme) => (
                  <label className={`appearance-choice ${theme.className}`} key={theme.id}>
                    <input
                      type="radio"
                      name="tile-theme"
                      value={theme.id}
                      checked={tileThemeId === theme.id}
                      onChange={(event) => changeTileTheme(event.target.value)}
                    />
                    <span className="appearance-tile-preview" aria-hidden="true">7</span>
                    <span><strong>{theme.name}</strong><small>{theme.note}</small></span>
                  </label>
                ))}
              </div>
            </fieldset>
          </aside>
        )}
      </div>

      <section className={`rack-zone ${isMyTurn ? "is-active" : ""}`}>
        <div className="rack-heading">
          <div className="rack-tools">
            <div className="rack-sort-tools" aria-label="Rack sorting">
              <button
                type="button"
                className={rackAutoSort && rackSortMode === "color-first" ? "is-active" : ""}
                aria-pressed={rackAutoSort && rackSortMode === "color-first"}
                title="Sort by color, then number"
                onClick={() => changeRackSort("color-first")}
              >Color → 123</button>
              <button
                type="button"
                className={rackAutoSort && rackSortMode === "number-first" ? "is-active" : ""}
                aria-pressed={rackAutoSort && rackSortMode === "number-first"}
                title="Sort by number, then color"
                onClick={() => changeRackSort("number-first")}
              >123 → Color</button>
              {isMyTurn && (selectedTileIds.length > 0 || draggedItem?.type === "set") && (
                <div className="selection-actions" aria-label="Selection actions">
                  {selectedTileIds.length > 0 && <button type="button" onClick={() => moveTiles(selectedTileIds, { type: "new" })}>New set <kbd aria-hidden="true">{optionModifier}↵</kbd></button>}
                  {selectionCanReturnToRack && <button type="button" onClick={() => moveTiles(selectedTileIds, { type: "rack" })}>Return to rack</button>}
                  <button type="button" onClick={() => {
                    clearTurnInteraction();
                    setInteractionAnnouncement("Selection canceled.");
                  }}>{draggedItem?.type === "set" ? "Cancel set move" : "Clear selection"} <kbd aria-hidden="true">Esc</kbd></button>
                </div>
              )}
            </div>
            {isMyTurn && (
              <div className="rack-turn-tools" aria-label="Turn history">
                <div className="turn-history-buttons">
                  <button type="button" disabled={busy || turnHistoryIndex === 0} onClick={() => showTurnHistory(turnHistoryIndex - 1)} title="Go back one move" aria-label="Back one move" aria-keyshortcuts="Control+Z Meta+Z"><Undo2 /> Back <kbd aria-hidden="true">{shortcutModifier}Z</kbd></button>
                  <button className="table-reset-button" type="button" disabled={busy || turnHistoryIndex === 0} onClick={resetDraft} title="Restore the table and rack to the start of your turn" aria-label="Reset turn" aria-keyshortcuts="Control+Shift+Backspace Meta+Shift+Backspace"><RotateCcw /> Reset <kbd aria-hidden="true">{shortcutModifier}⇧⌫</kbd></button>
                  <button type="button" disabled={busy || turnHistoryIndex >= turnHistory.length - 1} onClick={() => showTurnHistory(turnHistoryIndex + 1)} title="Go forward one move" aria-label="Forward one move" aria-keyshortcuts="Control+Y Meta+Y Control+Shift+Z Meta+Shift+Z">Forward <kbd aria-hidden="true">{redoShortcut}</kbd> <Redo2 /></button>
                </div>
              </div>
            )}
            {isMyTurn && (
              <div className="rack-action-tools" aria-label="Turn actions">
                <button className="secondary-button" type="button" disabled={busy} onClick={drawAndEnd} aria-label={game.poolCount === 0 ? "Pass & end" : "Draw & end"} aria-keyshortcuts="Control+Shift+Enter Meta+Shift+Enter"><ArrowDownToLine /> <span>{game.poolCount === 0 ? "Pass" : "Draw"}</span><kbd aria-hidden="true">{shortcutModifier}⇧↵</kbd></button>
                <button className="primary-button" type="button" disabled={!canCommit || busy} onClick={commitTurn} aria-label="Commit turn" aria-keyshortcuts="Control+Enter Meta+Enter"><Check /> <span>Commit</span><kbd aria-hidden="true">{shortcutModifier}↵</kbd></button>
              </div>
            )}
          </div>
        </div>

        <div
          className={`opening-meter ${openingPoints >= 30 ? "is-complete" : ""} ${me?.opened || !isMyTurn ? "layout-placeholder" : ""}`}
          aria-hidden={me?.opened || !isMyTurn}
        ><span style={{ width: `${Math.min(100, (openingPoints / 30) * 100)}%` }} /><b>Opening set: {openingPoints} / 30</b></div>

        <div
          className={`rack ${rackAutoSort ? "is-autosorted" : "is-manual"}`}
          role="grid"
          aria-label={`Your rack, ${rackAutoSort ? "autosorted" : "manual arrangement"}`}
          style={{ "--rack-slots-per-row": draftRackLayout.slotsPerRow } as CSSProperties}
          onDragOver={(event) => {
            event.preventDefault();
            const item = readDragItem(event);
            if (item?.type !== "tiles") return;
            const slot = rackSlotAtPoint(event.currentTarget, event.clientX, event.clientY);
            const slotIndex = Number.parseInt(slot?.dataset.rackSlot ?? "", 10);
            if (!slot || !Number.isInteger(slotIndex)) return;
            setRackDropTarget({
              slotIndex,
              side: rackDropSideForElement(slot, event.clientX),
            });
          }}
          onDragLeave={(event) => {
            if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) {
              setRackDropTarget(null);
            }
          }}
          onDrop={(event) => {
            const slot = rackSlotAtPoint(event.currentTarget, event.clientX, event.clientY);
            const slotIndex = Number.parseInt(slot?.dataset.rackSlot ?? "", 10);
            if (slot && Number.isInteger(slotIndex)) {
              event.preventDefault();
              drop(event, {
                type: "rack",
                slotIndex,
                side: rackDropSideForElement(slot, event.clientX),
              });
            } else {
              drop(event, { type: "rack" });
            }
          }}
        >
          {rackRows.map((row, rowIndex) => (
            <div className="rack-level" data-rack-row={rowIndex + 1} role="row" key={rowIndex}>
              {row.map((tileId, columnIndex) => {
                const slotIndex = rackSlotIndex(rowIndex, columnIndex);
                const tile = tileId ? game.tiles[tileId] : null;
                return (
                <div
                  className={`rack-slot ${tile ? "is-occupied" : "is-empty"} ${tileId && autosortedSetTileIds.has(tileId) ? "is-set" : ""} ${rackDropTarget?.slotIndex === slotIndex && draggedItem?.type === "tiles" ? "is-drop-target" : ""}`}
                  data-rack-slot={slotIndex}
                  data-rack-drop-side={rackDropTarget?.slotIndex === slotIndex ? rackDropTarget.side : undefined}
                  data-rack-set={tileId && autosortedSetTileIds.has(tileId) ? "true" : undefined}
                  role="gridcell"
                  aria-label={tile
                    ? `Rack row ${rowIndex + 1}, slot ${columnIndex + 1}, ${tileName(tile.id)}`
                    : `Empty rack row ${rowIndex + 1}, slot ${columnIndex + 1}`}
                  key={slotIndex}
                  onDragOver={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    event.dataTransfer.dropEffect = "move";
                    if (draggedItem?.type === "tiles") {
                      setRackDropTarget({ slotIndex, side: rackDropSideForEvent(event) ?? "before" });
                    }
                  }}
                  onDragLeave={(event) => {
                    const relatedTarget = event.relatedTarget;
                    if (!(relatedTarget instanceof Node) || !event.currentTarget.contains(relatedTarget)) {
                      setRackDropTarget((current) => current?.slotIndex === slotIndex ? null : current);
                    }
                  }}
                  onDrop={(event) => {
                    event.stopPropagation();
                    drop(event, { type: "rack", slotIndex, side: rackDropSideForEvent(event) });
                  }}
                >
                  {tile && (
                  <TileView
                    tile={tile}
                    selected={selectedTileIds.includes(tile.id)}
                    newActivity={newActivityTiles.has(tile.id)}
                    keyShortcuts={isMyTurn ? "Shift+Enter Alt+Enter Control+A Meta+A" : undefined}
                    onClick={(event) => handleTileClick(event, tile.id)}
                    onFocus={() => handleTileFocus(tile.id)}
                    onKeyDown={(event) => handleTileKeyDown(event, tile.id)}
                    onDoubleClick={() => handleRackTileDoubleClick(tile.id)}
                    onPointerDown={(event) => beginRackHold(event, tile.id)}
                    onPointerUp={cancelRackHold}
                    onPointerCancel={cancelRackHold}
                    onPointerLeave={cancelRackHold}
                    onContextMenu={(event) => { if (isMyTurn) event.preventDefault(); }}
                    onDragStart={(event) => dragTileStart(event, tile.id)}
                    onDragEnd={(event) => { event.stopPropagation(); finishDrag(); }}
                  />
                  )}
                </div>
                );
              })}
            </div>
          ))}
        </div>

        {error && <p className="turn-error" role="alert">{error}</p>}
      </section>

      {game.status === "finished" && (
        <div className="winner-banner">
          <div className="winner-crown"><Crown /></div>
          <div><p className="eyebrow">Game complete</p><h2>{game.players.find((player) => player.id === game.winnerId)?.name} wins the table!</h2></div>
          <div className="scores">{game.players.map((player) => <span key={player.id}><b>{player.name}</b><strong>{(game.scores?.[player.id] ?? 0) > 0 ? "+" : ""}{game.scores?.[player.id] ?? 0}</strong></span>)}</div>
          <button className="secondary-button" type="button" onClick={onExit}>Back home</button>
        </div>
      )}
    </main>
  );
}
