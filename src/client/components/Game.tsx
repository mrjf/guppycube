import {
  ArrowDownToLine,
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
  Lightbulb,
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
import { resolveWildcardAssignments, validateMeld, validateTurn } from "../../shared/rules";
import { findLinkedRackTileIds, groupSortedRackTileIds, normalizeMeldTileIds, sortTileIds } from "../../shared/sorting";
import type { TileSortMode } from "../../shared/sorting";
import { ASSIST_DEFINITIONS } from "../../shared/types";
import type { AssistId, ComputerStrategyId, GameEvent, GameSession, Meld, PublicGameState } from "../../shared/types";
import { validators } from "../../validation";
import { addComputer, ApiRequestError, getGame, saveTurnDraft, setAssist, socketUrl, startGame, takeAction } from "../api";
import { appPath } from "../base-path";
import { createFeltLayout } from "../felt-layout";
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
import type { RackLayout } from "../rack-layout";
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
  | { type: "rack"; slotIndex?: number }
  | { type: "new"; meldId?: string }
  | { type: "meld"; meldId: string };

type DragItem =
  | { type: "tiles"; tileIds: string[] }
  | { type: "meld"; meldId: string };

interface TurnDraft {
  board: Meld[];
  rackLayout: RackLayout;
}

const DRAG_ITEM_TYPE = "application/x-guppycube-item";
const RACK_HOLD_MS = 500;
const RACK_HOLD_REPEAT_MS = 350;
const ENABLED_TILE_SELECTOR = ".tile[data-tile-id]:not(:disabled)";
const COMPUTER_RACK_PREFERENCE_KEY = "guppycube:show-computer-racks";
const RACK_AUTOSORT_PREFERENCE_KEY = "guppycube:rack-autosort";
const COLOR_THEME_PREFERENCE_KEY = "guppycube:color-theme";
const TILE_THEME_PREFERENCE_KEY = "guppycube:tile-theme";
const ALL_COMPUTER_RACKS = "*";

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

function tileButtons(root: ParentNode): HTMLButtonElement[] {
  return [...root.querySelectorAll<HTMLButtonElement>(ENABLED_TILE_SELECTOR)];
}

function directionalTile(
  current: HTMLButtonElement,
  key: "ArrowDown" | "ArrowLeft" | "ArrowRight" | "ArrowUp",
): HTMLButtonElement | null {
  const root = current.closest(".game-shell");
  if (!root) return null;
  const currentBox = current.getBoundingClientRect();
  const currentX = currentBox.left + currentBox.width / 2;
  const currentY = currentBox.top + currentBox.height / 2;
  const horizontal = key === "ArrowLeft" || key === "ArrowRight";
  const direction = key === "ArrowLeft" || key === "ArrowUp" ? -1 : 1;

  return tileButtons(root)
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
const ACTION_FLASH_MS = 3_200;
const NEW_ACTIVITY_MS = 850;
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

function boardKey(board: Meld[]): string {
  return JSON.stringify(
    board
      .map((meld) => [...meld.tileIds].sort().join("|"))
      .sort(),
  );
}

function draftKey(draft: TurnDraft): string {
  return JSON.stringify({
    board: draft.board.map((meld) => meld.tileIds),
    rackSlots: draft.rackLayout.slots,
  });
}

function authoritativePositionKey(game: PublicGameState | null): string {
  if (!game) return "";
  const visibleOpponentDraft = game.currentPlayerId === game.myPlayerId ? null : game.turnDraft;
  return JSON.stringify({
    status: game.status,
    currentPlayerId: game.currentPlayerId,
    board: game.board.map((meld) => meld.tileIds),
    rack: [...game.myRack].sort(),
    turnDraft: visibleOpponentDraft?.map((meld) => meld.tileIds) ?? null,
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
  const [draftBoard, setDraftBoard] = useState<Meld[]>([]);
  const [draftRackLayout, setDraftRackLayout] = useState<RackLayout>(() => createRackLayout([]));
  const [rackLayoutOwnerKey, setRackLayoutOwnerKey] = useState<string | null>(null);
  const [turnHistory, setTurnHistory] = useState<TurnDraft[]>([]);
  const [turnHistoryIndex, setTurnHistoryIndex] = useState(0);
  const [selectedTileIds, setSelectedTileIds] = useState<string[]>([]);
  const [draggedItem, setDraggedItem] = useState<DragItem | null>(null);
  const [dropTargetMeldId, setDropTargetMeldId] = useState<string | null>(null);
  const [connection, setConnection] = useState<"connecting" | "online" | "offline">("connecting");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [interactionAnnouncement, setInteractionAnnouncement] = useState("");
  const [focusedTileId, setFocusedTileId] = useState<string | null>(null);
  const [keyboardNavigationActive, setKeyboardNavigationActive] = useState(false);
  const [copied, setCopied] = useState(false);
  const [showActivity, setShowActivity] = useState(false);
  const [showAssists, setShowAssists] = useState(false);
  const [showAppearance, setShowAppearance] = useState(false);
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
  const suppressTileClick = useRef<string | null>(null);
  const doubleClickMeldId = useRef<string | null>(null);
  const selectionAnchorId = useRef<string | null>(null);
  const actionRoomId = useRef<string | null>(null);
  const seenOpponentActionIds = useRef<Set<string>>(new Set());
  const observedBoardTileIds = useRef<Set<string>>(new Set());
  const observedRackTileIds = useRef<Set<string>>(new Set());
  const actionFlashTimer = useRef<number | null>(null);
  const newActivityTimer = useRef<number | null>(null);
  const draftSequence = useRef(0);
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

  useEffect(() => () => {
    if (actionFlashTimer.current !== null) window.clearTimeout(actionFlashTimer.current);
    if (newActivityTimer.current !== null) window.clearTimeout(newActivityTimer.current);
  }, []);

  useEffect(() => {
    if (!game) return;
    const boardTileIds = new Set(game.board.flatMap((meld) => meld.tileIds));
    const rackTileIds = new Set(game.myRack);
    const opponentActions = game.history.filter((item) =>
      item.playerId !== null
      && item.playerId !== game.myPlayerId
      && TURN_EVENT_KINDS.has(item.kind),
    );

    if (actionRoomId.current !== game.id) {
      actionRoomId.current = game.id;
      seenOpponentActionIds.current = new Set(opponentActions.map((item) => item.id));
      observedBoardTileIds.current = boardTileIds;
      observedRackTileIds.current = rackTileIds;
      setFlashedAction(null);
      setNewActivityTileIds([]);
      return;
    }

    const unseenActions = opponentActions.filter((item) => !seenOpponentActionIds.current.has(item.id));
    for (const item of opponentActions) seenOpponentActionIds.current.add(item.id);
    const latestAction = unseenActions.at(-1);
    const previousBoardTileIds = observedBoardTileIds.current;
    const previousRackTileIds = observedRackTileIds.current;
    observedBoardTileIds.current = boardTileIds;
    observedRackTileIds.current = rackTileIds;

    const newBoardTileIds = latestAction?.kind === "played"
      ? [...boardTileIds].filter((tileId) => !previousBoardTileIds.has(tileId))
      : [];
    const newRackTileIds = [...rackTileIds].filter((tileId) => !previousRackTileIds.has(tileId));
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
    const visibleBoard = game.currentPlayerId === game.myPlayerId
      ? game.myTurnDraft
      : game.turnDraft;
    const board = (visibleBoard ?? game.board).map((meld) => ({
      ...meld,
      tileIds: normalizeMeldTileIds(meld.tileIds, game.tiles),
    }));
    const draftedTileIds = new Set(board.flatMap((meld) => meld.tileIds));
    const rackTileIds = game.myRack.filter((tileId) => !draftedTileIds.has(tileId));
    const layoutKey = rackLayoutPreferenceKey(game.id, game.myPlayerId);
    const storedLayout = parseRackLayout(localStorage.getItem(layoutKey));
    const rackLayout = rackAutoSort
      ? createRackLayout(sortTileIds(rackTileIds, game.tiles, rackSortMode))
      : reconcileRackLayout(
          storedLayout ?? createRackLayout(rackTileIds),
          rackTileIds,
          MANUAL_RACK_SLOTS_PER_ROW,
        );
    setDraftBoard(board);
    setDraftRackLayout(rackLayout);
    setRackLayoutOwnerKey(layoutKey);
    setTurnHistory([{ board, rackLayout }]);
    setTurnHistoryIndex(0);
    setSelectedTileIds([]);
    setDraggedItem(null);
    setDropTargetMeldId(null);
    doubleClickMeldId.current = null;
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
  const originalBoardTiles = useMemo(() => new Set(game?.board.flatMap((meld) => meld.tileIds) ?? []), [positionKey]);
  const originalRackTiles = useMemo(() => new Set(game?.myRack ?? []), [positionKey]);
  const selectionCanReturnToRack = selectedTileIds.length > 0
    && selectedTileIds.every((tileId) => originalRackTiles.has(tileId))
    && selectedTileIds.some((tileId) => !draftRack.includes(tileId));
  const activeColorTheme = colorThemeById(colorThemeId);
  const activeTileTheme = tileThemeById(tileThemeId);
  const shortcutModifier = useMemo(() => isApplePlatform() ? "⌘" : "Ctrl", []);
  const optionModifier = useMemo(() => isApplePlatform() ? "⌥" : "Alt", []);
  const rackRows = useMemo(() => rackSlotRows(draftRackLayout), [draftRackLayout]);
  const autosortedMeldTileIds = useMemo(() => new Set(
    rackAutoSort && game?.enabledAssists.includes("rack-meld-highlights")
      ? groupSortedRackTileIds(draftRack, game.tiles)
          .filter((group) => group.isMeld)
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
    const tableTileIds = new Set(game.board.flatMap((meld) => meld.tileIds));
    const attemptedTileIds = draftBoard
      .flatMap((meld) => meld.tileIds)
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
    return draftBoard.reduce((sum, meld) => {
      if (!meld.tileIds.some((id) => originalRackTiles.has(id))) return sum;
      if (meld.tileIds.some((id) => !originalRackTiles.has(id))) return sum;
      const result = validateMeld(meld.tileIds, game.tiles);
      return sum + (result.valid ? result.points : 0);
    }, 0);
  }, [draftBoard, game, me?.opened, originalRackTiles]);

  const feltLayout = useMemo(() => createFeltLayout(
    draftBoard.map((meld) => ({
      id: meld.id,
      tileCount: meld.tileIds.length,
      orderKey: meld.tileIds.map((tileId) => {
        const tile = game?.tiles[tileId];
        if (!tile) return `missing:${tileId}`;
        return tile.wildcard
          ? "wildcard"
          : `${tile.color ?? ""}:${String(tile.value ?? 0).padStart(2, "0")}`;
      }).join("|"),
    })),
    feltBounds.width,
    feltBounds.height,
    { width: feltBounds.obstacleWidth, height: feltBounds.obstacleHeight },
  ), [
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
    return tile.wildcard ? "Wildcard" : `${tile.color} ${tile.value}`;
  }

  function feltMeldNumber(meldId: string): number {
    const canonicalIndex = feltLayout.placements.findIndex((placement) => placement.id === meldId);
    return canonicalIndex >= 0 ? canonicalIndex + 1 : draftBoard.findIndex((meld) => meld.id === meldId) + 1;
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
    let next = previous ?? selected;
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
    setKeyboardNavigationActive(true);
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
    return draftBoard.find((meld) => meld.tileIds.includes(tileId))?.tileIds ?? [];
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
    setDropTargetMeldId(null);
    selectionAnchorId.current = null;
    setError("");
  }

  function syncTurnDraft(board: Meld[]) {
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

  function recordDraft(board: Meld[], rackLayout: RackLayout) {
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
      ? createRackLayout(sortTileIds(rackTileIds(draft.rackLayout), game.tiles, rackSortMode))
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
      const manualRackLayout = rackAutoSort
        ? reconcileRackLayout(draftRackLayout, draftRack, MANUAL_RACK_SLOTS_PER_ROW)
        : draftRackLayout;
      const nextRackLayout = placeRackTilesAtSlot(manualRackLayout, movingTileIds, personalRackSlotIndex);
      setRackAutoSort(false);
      localStorage.setItem(RACK_AUTOSORT_PREFERENCE_KEY, "false");
      setDraftRackLayout(nextRackLayout);
      setTurnHistory((history) => history.map((draft) => {
        const tileIdsInDraftRack = new Set(rackTileIds(draft.rackLayout));
        const manualDraftLayout = rackAutoSort
          ? reconcileRackLayout(draft.rackLayout, rackTileIds(draft.rackLayout), MANUAL_RACK_SLOTS_PER_ROW)
          : draft.rackLayout;
        return movingTileIds.every((tileId) => tileIdsInDraftRack.has(tileId))
          ? { ...draft, rackLayout: placeRackTilesAtSlot(manualDraftLayout, movingTileIds, personalRackSlotIndex) }
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
      setError("A table tile cannot return to your rack. Move it into another meld.");
      return;
    }

    const sourceMeldIds = new Set(
      draftBoard
        .filter((meld) => meld.tileIds.some((tileId) => movingTiles.has(tileId)))
        .map((meld) => meld.id),
    );
    if (target.type === "meld" && sourceMeldIds.size === 1 && sourceMeldIds.has(target.meldId)) {
      setSelectedTileIds([]);
      setDraggedItem(null);
      setDropTargetMeldId(null);
      return;
    }

    let nextRackLayout = removeRackTiles(draftRackLayout, movingTiles);
    let nextBoard = draftBoard
      .map((meld) => ({
        ...meld,
        tileIds: normalizeMeldTileIds(
          meld.tileIds.filter((id) => !movingTiles.has(id)),
          game.tiles,
        ),
      }))
      .filter((meld) => meld.tileIds.length > 0);

    if (target.type === "rack") {
      if (movingTileIds.every((tileId) => originalRackTiles.has(tileId))) {
        if (rackAutoSort) {
          nextRackLayout = createRackLayout(
            sortTileIds([...rackTileIds(nextRackLayout), ...movingTileIds], game.tiles, rackSortMode),
            draftRackLayout.slotsPerRow,
          );
        } else if (target.slotIndex !== undefined) {
          nextRackLayout = placeRackTilesAtSlot(draftRackLayout, movingTileIds, target.slotIndex);
        } else {
          nextRackLayout = reconcileRackLayout(
            nextRackLayout,
            [...rackTileIds(nextRackLayout), ...movingTileIds],
          );
        }
      }
    } else if (target.type === "new") {
      nextBoard.push({
        id: target.meldId ?? `draft-${crypto.randomUUID()}`,
        tileIds: normalizeMeldTileIds(movingTileIds, game.tiles),
      });
    } else {
      const targetIndex = nextBoard.findIndex((meld) => meld.id === target.meldId);
      if (targetIndex < 0) return;
      const meld = nextBoard[targetIndex]!;
      nextBoard[targetIndex] = {
        ...meld,
        tileIds: normalizeMeldTileIds([...meld.tileIds, ...movingTileIds], game.tiles),
      };
    }

    const destination = target.type === "rack"
      ? "your rack"
      : target.type === "new"
        ? "a new meld"
        : `meld ${feltMeldNumber(target.meldId)}`;
    setInteractionAnnouncement(`Moved ${movingTileIds.length} ${movingTileIds.length === 1 ? "tile" : "tiles"} to ${destination}.`);
    recordDraft(nextBoard, nextRackLayout);
  }

  function mergeMelds(sourceMeldId: string, targetMeldId: string) {
    if (!isMyTurn || !game || sourceMeldId === targetMeldId) {
      setDraggedItem(null);
      setDropTargetMeldId(null);
      return;
    }
    const source = draftBoard.find((meld) => meld.id === sourceMeldId);
    const target = draftBoard.find((meld) => meld.id === targetMeldId);
    if (!source || !target) return;

    const nextBoard = draftBoard
      .filter((meld) => meld.id !== sourceMeldId)
      .map((meld) => meld.id === targetMeldId
        ? {
            ...meld,
            tileIds: normalizeMeldTileIds([...meld.tileIds, ...source.tileIds], game.tiles),
          }
        : meld);
    setInteractionAnnouncement("Combined the two melds.");
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

  function handleTileKeyDown(
    event: ReactKeyboardEvent<HTMLButtonElement>,
    tileId: string,
  ) {
    if (!isMyTurn) return;
    setKeyboardNavigationActive(true);
    setFocusedTileId(tileId);

    if (event.altKey && event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      const tileIds = selectedTileIds.includes(tileId) ? selectedTileIds : [tileId];
      moveTiles(tileIds, { type: "new" });
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
      const next = directionalTile(event.currentTarget, event.key as typeof navigationKeys[number]);
      if (!next) return;
      const nextTileId = next.dataset.tileId;
      if (event.shiftKey && nextTileId) extendSelectionTo(tileId, nextTileId);
      next.focus();
      return;
    }

    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const root = event.metaKey || event.ctrlKey
        ? event.currentTarget.closest(".game-shell")
        : event.currentTarget.closest(".meld-tiles, .rack-level");
      if (!root) return;
      const candidates = tileButtons(root);
      const next = event.key === "Home" ? candidates[0] : candidates.at(-1);
      if (!next) return;
      const nextTileId = next.dataset.tileId;
      if (event.shiftKey && nextTileId) extendSelectionTo(tileId, nextTileId);
      next.focus();
    }
  }

  function pickUpOrMergeMeld(meldId: string) {
    if (!isMyTurn) return;
    if (draggedItem?.type === "meld") {
      if (draggedItem.meldId === meldId) {
        setDraggedItem(null);
        setInteractionAnnouncement("Meld move canceled.");
      } else {
        mergeMelds(draggedItem.meldId, meldId);
      }
      return;
    }
    setSelectedTileIds([]);
    selectionAnchorId.current = null;
    setDraggedItem({ type: "meld", meldId });
    const meldNumber = feltMeldNumber(meldId);
    setInteractionAnnouncement(`Picked up meld ${meldNumber}. Choose another meld's move button to combine them, or press Escape to cancel.`);
  }

  function handleRackTileDoubleClick(tileId: string) {
    if (!isMyTurn || !game) return;
    cancelRackHold();

    const activeMeldId = doubleClickMeldId.current;
    if (activeMeldId && draftBoard.some((meld) => meld.id === activeMeldId)) {
      moveTiles([tileId], { type: "meld", meldId: activeMeldId });
      return;
    }

    const meldId = `draft-${crypto.randomUUID()}`;
    doubleClickMeldId.current = meldId;
    moveTiles([tileId], { type: "new", meldId });
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
    setSelectedTileIds(tileIds);
    setDraggedItem(item);
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

  function dragMeldStart(event: DragEvent<HTMLDivElement>, meldId: string) {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(DRAG_ITEM_TYPE, JSON.stringify({ type: "meld", meldId }));
    event.dataTransfer.setData("text/meld-id", meldId);
    setSelectedTileIds([]);
    setDraggedItem({ type: "meld", meldId });
  }

  function readDragItem(event: DragEvent<HTMLElement>): DragItem | null {
    const encoded = event.dataTransfer.getData(DRAG_ITEM_TYPE);
    if (encoded) {
      try {
        const item = JSON.parse(encoded) as DragItem;
        if (item.type === "tiles" && Array.isArray(item.tileIds) && item.tileIds.every((id) => typeof id === "string")) return item;
        if (item.type === "meld" && item.meldId) return item;
      } catch {
        // Fall through to the broadly supported plain-text transfer types.
      }
    }
    const meldId = event.dataTransfer.getData("text/meld-id");
    if (meldId) return { type: "meld", meldId };
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

  function drop(event: DragEvent<HTMLElement>, target: MoveTarget) {
    event.preventDefault();
    const item = readDragItem(event);
    if (!item) return;
    if (item.type === "tiles") {
      moveTiles(item.tileIds, target);
    } else if (target.type === "meld") {
      mergeMelds(item.meldId, target.meldId);
    } else if (target.type === "rack") {
      setError("A whole meld cannot move to your rack. Drag an eligible rack tile instead.");
      setDraggedItem(null);
      setDropTargetMeldId(null);
    } else {
      setDraggedItem(null);
      setDropTargetMeldId(null);
    }
  }

  function finishDrag() {
    setDraggedItem(null);
    setDropTargetMeldId(null);
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
      setDraftRackLayout(createRackLayout(sortTileIds(draftRack, game.tiles, nextMode)));
      setTurnHistory((history) => history.map((draft) => ({
        ...draft,
        rackLayout: createRackLayout(sortTileIds(rackTileIds(draft.rackLayout), game.tiles, nextMode)),
      })));
      clearTurnInteraction();
    }
  }

  async function runAction(action: Parameters<typeof takeAction>[1]) {
    setBusy(true);
    setError("");
    try {
      await takeAction(session, action);
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
    const invite = `${window.location.origin}${appPath(`/room/${session.roomCode}`)}`;
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

  function drawAndEnd() {
    if (!isMyTurn || busy) return;
    if (dirty && !window.confirm("Discard your table changes and draw a tile?")) return;
    setInteractionAnnouncement("Drawing a tile and ending your turn.");
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

  useEffect(() => {
    function handleGameShortcut(event: KeyboardEvent) {
      if (event.defaultPrevented || event.repeat || isTypingTarget(event.target)) return;

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

    window.addEventListener("keydown", handleGameShortcut);
    return () => window.removeEventListener("keydown", handleGameShortcut);
  });

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
            <span>Table name</span><strong>{game.id}</strong><small>{copied ? <><Check size={15} /> Copied invite link</> : <><Copy size={15} /> Click to copy invite</>}</small>
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
          <div className="lobby-meta"><span><Clock3 size={17} /> {game.mode === "realtime" ? "2-minute turns" : "72-hour turns"}</span><span><Users size={17} /> {game.players.length} of {game.maxPlayers}</span></div>
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
  const meldsById = new Map(draftBoard.map((meld) => [meld.id, meld]));

  return (
    <main className={`game-shell ${activeColorTheme.className} ${activeTileTheme.className} ${keyboardNavigationActive ? "is-keyboard-navigating" : ""}`}>
      <p className="sr-only" aria-live="polite" aria-atomic="true">{interactionAnnouncement}</p>
      <header className="game-header">
        <button className="wordmark wordmark-button compact-mark" type="button" onClick={onExit} aria-label="guppycube home"><span><CatFaceIcon className="wordmark-cat" /></span><b>guppycube</b></button>
        <div className="room-pill"><span>TABLE</span> {game.id}</div>
        <div className="header-actions">
          <span className={`connection-pill is-${connection}`}>{connection === "online" ? <Wifi /> : <WifiOff />} {connection}</span>
          <button className="icon-button" type="button" aria-pressed={showAppearance} onClick={() => { setShowAppearance(!showAppearance); setShowAssists(false); setShowActivity(false); }} aria-label="Appearance"><Palette /></button>
          <button className="icon-button" type="button" aria-pressed={showAssists} onClick={() => { setShowAssists(!showAssists); setShowAppearance(false); setShowActivity(false); }} aria-label="Assists"><SlidersHorizontal /></button>
          <button className="icon-button" type="button" aria-pressed={showActivity} onClick={() => { setShowActivity(!showActivity); setShowAppearance(false); setShowAssists(false); }} aria-label="Activity"><History /></button>
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
          <div
            className={`top-turn-actions ${!isMyTurn || game.status !== "playing" ? "layout-placeholder" : ""}`}
            aria-hidden={!isMyTurn || game.status !== "playing"}
          >
            <button className="secondary-button" type="button" disabled={!isMyTurn || busy} onClick={drawAndEnd} aria-keyshortcuts="Control+Shift+Enter Meta+Shift+Enter"><ArrowDownToLine /> <span>Draw & end</span><kbd aria-hidden="true">{shortcutModifier}⇧↵</kbd></button>
            <button className="primary-button" type="button" disabled={!isMyTurn || !canCommit || busy} onClick={commitTurn} aria-keyshortcuts="Control+Enter Meta+Enter"><Check /> <span>Commit turn</span><kbd aria-hidden="true">{shortcutModifier}↵</kbd></button>
          </div>
        </div>
      </section>

      <div className={`table-topline ${selectedTileIds.length > 0 || draggedItem ? "has-selected-tile" : ""}`}>
        <div className="table-summary"><span className="eyebrow">The table</span><b>{draftBoard.flatMap((meld) => meld.tileIds).length} tiles down</b></div>
        <div className={`table-drop-instruction ${!isMyTurn ? "is-watching" : ""} ${hasBoardDefect ? "has-defect" : ""}`} aria-live="polite">
          {isMyTurn ? <>
            <Plus /> {draggedItem?.type === "meld"
              ? "Choose another meld's move button to combine them, or press Escape to cancel"
              : selectedTileIds.length > 1
                ? `Move ${selectedTileIds.length} selected tiles to open table space or a meld`
                : selectedTileIds.length === 1
                  ? "Tap open table space to start a new meld, or tap a meld to add it"
                  : "Drag a tile or a whole meld to reorganize the table"}
          </> : <>
            <Eye aria-hidden="true" />
            <span>
              {hasLiveOpponentDraft
                ? <><b>Live</b> {currentPlayer?.name ?? "The current player"} is arranging the table</>
                : <>Watch the table—{currentPlayer?.name ?? "the current player"}'s moves will appear here</>}
              {hasBoardDefect && visibleTurnValidation?.reason && <small>{visibleTurnValidation.reason}</small>}
            </span>
          </>}
        </div>
        <div
          className={`table-turn-tools ${!isMyTurn || game.status !== "playing" ? "layout-placeholder" : ""}`}
          aria-hidden={!isMyTurn || game.status !== "playing"}
        >
          <div className="turn-history-buttons" aria-label="Turn history">
            <button type="button" disabled={!isMyTurn || busy || turnHistoryIndex === 0} onClick={() => showTurnHistory(turnHistoryIndex - 1)} title="Go back one move" aria-label="Back one move"><Undo2 /> Back</button>
            <button type="button" disabled={!isMyTurn || busy || turnHistoryIndex >= turnHistory.length - 1} onClick={() => showTurnHistory(turnHistoryIndex + 1)} title="Go forward one move" aria-label="Forward one move">Forward <Redo2 /></button>
          </div>
          <button className="table-reset-button" type="button" disabled={!isMyTurn || busy || turnHistoryIndex === 0} onClick={resetDraft} title="Restore the table and rack to the start of your turn"><RotateCcw /> Reset turn</button>
        </div>
      </div>

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
            disabled={!isMyTurn || busy || game.poolCount === 0}
            aria-label={`Draw one tile and end turn. ${game.poolCount} tiles remain in the pool.`}
            title={isMyTurn ? "Draw one tile and end your turn" : `${currentPlayer?.name ?? "Another player"} is drawing`}
            onClick={(event) => {
              event.stopPropagation();
              drawAndEnd();
            }}
          ><span className="tile-stack-icon" aria-hidden="true" /><span><small>Draw pile</small><strong>{game.poolCount}</strong></span></button>

          <div className="melds" ref={feltRef}>
            {feltLayout.placements.length > 0 && (
              <div
                className="meld-grid"
                data-felt-rows={feltLayout.rowCount}
                data-felt-scale={feltLayout.scale.toFixed(2)}
              >
                {feltLayout.placements.map((placement) => {
                  const meld = meldsById.get(placement.id);
                  if (!meld) return null;
                  const meldIndex = placement.order;
                  const validation = validateMeld(meld.tileIds, game.tiles);
                  const wildcardAssignments = resolveWildcardAssignments(meld.tileIds, game.tiles);
                  return (
                    <div
                      className={`meld ${validation.valid ? "is-valid" : "is-invalid"} ${draggedItem?.type === "meld" && draggedItem.meldId === meld.id ? "is-dragging" : ""} ${dropTargetMeldId === meld.id ? "is-drop-target" : ""}`}
                      key={meld.id}
                      data-felt-row={placement.row + 1}
                      style={{
                        "--felt-x": `${placement.x}px`,
                        "--felt-y": `${placement.y}px`,
                        "--felt-scale": feltLayout.scale,
                        "--felt-meld-width": `${placement.width / feltLayout.scale}px`,
                      } as CSSProperties}
                      draggable={isMyTurn}
                      aria-label={`Meld ${meldIndex + 1}, ${validation.valid ? validation.kind : "unfinished"}.${selectedTileIds.length > 0 ? ` Click to add ${selectedTileIds.length === 1 ? "the selected tile" : `${selectedTileIds.length} selected tiles`}.` : " Drag to merge with another meld."}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        if (draggedItem?.type === "meld" && draggedItem.meldId !== meld.id) {
                          mergeMelds(draggedItem.meldId, meld.id);
                          return;
                        }
                        if (selectedTileIds.length > 0 && !(event.target as HTMLElement).closest(".tile")) {
                          moveTiles(selectedTileIds, { type: "meld", meldId: meld.id });
                        }
                      }}
                      onDragStart={(event) => dragMeldStart(event, meld.id)}
                      onDragEnd={finishDrag}
                      onDragOver={(event) => {
                        if (!isMyTurn) return;
                        event.preventDefault();
                        event.stopPropagation();
                        event.dataTransfer.dropEffect = "move";
                        if (draggedItem?.type !== "meld" || draggedItem.meldId !== meld.id) {
                          setDropTargetMeldId(meld.id);
                        }
                      }}
                      onDrop={(event) => {
                        event.stopPropagation();
                        drop(event, { type: "meld", meldId: meld.id });
                      }}
                    >
                      <span className="meld-number">{String(meldIndex + 1).padStart(2, "0")}</span>
                      {isMyTurn && (
                        <button
                          className="meld-drag-handle"
                          type="button"
                          aria-pressed={draggedItem?.type === "meld" && draggedItem.meldId === meld.id}
                          aria-label={draggedItem?.type === "meld" && draggedItem.meldId !== meld.id
                            ? `Combine picked-up meld with meld ${meldIndex + 1}`
                            : `${draggedItem?.type === "meld" ? "Put down" : "Pick up"} meld ${meldIndex + 1}`}
                          title="Pick up this whole meld; choose another meld to combine"
                          onClick={(event) => {
                            event.stopPropagation();
                            pickUpOrMergeMeld(meld.id);
                          }}
                        ><GripVertical /></button>
                      )}
                      <div className="meld-tiles">
                        {meld.tileIds.map((tileId) => {
                          const tile = game.tiles[tileId];
                          if (!tile) return null;
                          return (
                            <TileView
                              key={tileId}
                              tile={tile}
                              wildcardAssignment={wildcardAssignments[tileId]}
                              wildcardOnTable
                              selected={selectedTileIds.includes(tileId)}
                              newActivity={newActivityTiles.has(tileId)}
                              disabled={!isMyTurn}
                          keyShortcuts="Shift+Enter Alt+Enter Control+A Meta+A"
                          onClick={(event) => handleTileClick(event, tileId)}
                          onFocus={() => handleTileFocus(tileId)}
                          onKeyDown={(event) => handleTileKeyDown(event, tileId)}
                              onDragStart={(event) => dragTileStart(event, tileId)}
                              onDragEnd={(event) => { event.stopPropagation(); finishDrag(); }}
                              onDrop={(event) => { event.stopPropagation(); drop(event, { type: "meld", meldId: meld.id }); }}
                            />
                          );
                        })}
                      </div>
                      <span className="meld-status">{validation.valid ? validation.kind : "unfinished"}</span>
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
          </div>
        </div>

        <div
          className={`opening-meter ${openingPoints >= 30 ? "is-complete" : ""} ${me?.opened || !isMyTurn ? "layout-placeholder" : ""}`}
          aria-hidden={me?.opened || !isMyTurn}
        ><span style={{ width: `${Math.min(100, (openingPoints / 30) * 100)}%` }} /><b>Opening meld: {openingPoints} / 30</b></div>

        <div
          className={`rack ${rackAutoSort ? "is-autosorted" : "is-manual"}`}
          role="grid"
          aria-label={`Your rack, ${rackAutoSort ? "autosorted" : "manual arrangement"}`}
          style={{ "--rack-slots-per-row": draftRackLayout.slotsPerRow } as CSSProperties}
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => drop(event, { type: "rack" })}
        >
          {rackRows.map((row, rowIndex) => (
            <div className="rack-level" data-rack-row={rowIndex + 1} role="row" key={rowIndex}>
              {row.map((tileId, columnIndex) => {
                const slotIndex = rackSlotIndex(rowIndex, columnIndex);
                const tile = tileId ? game.tiles[tileId] : null;
                return (
                <div
                  className={`rack-slot ${tile ? "is-occupied" : "is-empty"} ${tileId && autosortedMeldTileIds.has(tileId) ? "is-meld" : ""}`}
                  data-rack-slot={slotIndex}
                  data-rack-meld={tileId && autosortedMeldTileIds.has(tileId) ? "true" : undefined}
                  role="gridcell"
                  aria-label={tile
                    ? `Rack row ${rowIndex + 1}, slot ${columnIndex + 1}, ${tileName(tile.id)}`
                    : `Empty rack row ${rowIndex + 1}, slot ${columnIndex + 1}`}
                  key={slotIndex}
                  onDragOver={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    event.dataTransfer.dropEffect = "move";
                  }}
                  onDrop={(event) => {
                    event.stopPropagation();
                    drop(event, { type: "rack", slotIndex });
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
        <div className="turn-actions">
          <div className="turn-action-copy">
            <div className={`turn-guidance ${game.noMovePossible && game.enabledAssists.includes("no-move-alert") ? "is-no-move" : ""}`} role="status" aria-live="polite">
              {game.status === "finished"
                ? <><Crown /> Game over</>
                : isMyTurn && game.noMovePossible && game.enabledAssists.includes("no-move-alert")
                  ? <><Lightbulb /> No legal move is available.{game.enabledAssists.includes("auto-draw") ? " Auto-draw will end this turn." : " Draw to end your turn."}</>
                  : isMyTurn
                    ? <><span className="pulse-dot" /> {turnValidation?.reason ?? "Your play is ready to commit."}</>
                    : <><Clock3 /> Watch the table—your rack stays private.</>}
            </div>
            {isMyTurn && (selectedTileIds.length > 0 || draggedItem?.type === "meld") && (
              <div className="selection-actions" aria-label="Selection actions">
                {selectedTileIds.length > 0 && <button type="button" onClick={() => moveTiles(selectedTileIds, { type: "new" })}>New meld <kbd aria-hidden="true">{optionModifier}↵</kbd></button>}
                {selectionCanReturnToRack && <button type="button" onClick={() => moveTiles(selectedTileIds, { type: "rack" })}>Return to rack</button>}
                <button type="button" onClick={() => {
                  clearTurnInteraction();
                  setInteractionAnnouncement("Selection canceled.");
                }}>{draggedItem?.type === "meld" ? "Cancel meld move" : "Clear selection"} <kbd aria-hidden="true">Esc</kbd></button>
              </div>
            )}
          </div>
        </div>
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
