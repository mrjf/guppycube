import { ArrowRight, ChevronRight, Clock3, Copy, History, Play, Users } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import { DEFAULT_ASSIST_POLICY } from "../../shared/assists";
import { ASSIST_DEFINITIONS, ASSIST_POLICIES } from "../../shared/types";
import type { AssistPolicy, AssistPolicyMap, GameMode } from "../../shared/types";
import type { GameHistoryEntry } from "../../schemas";
import {
  formatTableNameInput,
  normalizeTableName,
  TABLE_NAME_MAX_LENGTH,
  TABLE_NAME_PATTERN,
} from "../../shared/table-name";
import { createGame, getGameHistory, joinGame } from "../api";
import { appPath } from "../base-path";
import { CatFaceIcon } from "./CatFaceIcon";

interface HomeProps {
  initialRoom?: string;
  onEnter: (roomCode: string) => void;
  onShowRules: () => void;
}

export function Home({ initialRoom = "", onEnter, onShowRules }: HomeProps) {
  const [history, setHistory] = useState<GameHistoryEntry[]>([]);
  const [name, setName] = useState("");
  const [mode, setMode] = useState<GameMode>("realtime");
  const [maxPlayers, setMaxPlayers] = useState(4);
  const [assistPolicy, setAssistPolicy] = useState<AssistPolicyMap>(() => ({ ...DEFAULT_ASSIST_POLICY }));
  const [roomCode, setRoomCode] = useState(initialRoom);
  const [tab, setTab] = useState<"create" | "join">(initialRoom ? "join" : "create");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const createTabRef = useRef<HTMLButtonElement>(null);
  const joinTabRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let active = true;
    getGameHistory()
      .then(({ games }) => {
        if (active) setHistory(games);
      })
      .catch(() => {
        // An empty history should not prevent creating or joining a table.
      });
    return () => { active = false; };
  }, []);

  function handleTabKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    let nextTab: "create" | "join" | null = null;
    if (event.key === "ArrowLeft" || event.key === "Home") nextTab = "create";
    if (event.key === "ArrowRight" || event.key === "End") nextTab = "join";
    if (!nextTab) return;
    event.preventDefault();
    setTab(nextTab);
    (nextTab === "create" ? createTabRef : joinTabRef).current?.focus();
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const session = tab === "create"
        ? await createGame({ name, mode, maxPlayers, assistPolicy })
        : await joinGame(normalizeTableName(roomCode), name);
      onEnter(session.roomCode);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="home-shell">
      <nav className="home-nav">
        <a className="wordmark" href={appPath("/")} aria-label="guppycube home"><span><CatFaceIcon className="wordmark-cat" /></span> guppycube</a>
        <button className="text-button" type="button" onClick={onShowRules}>How to play</button>
      </nav>

      <section className="hero">
        <div className="hero-copy">
          <h1>Make a run<br /><em>for it.</em></h1>
          <p className="hero-lede">Build clever sets. Break the table wide open. Play live tonight—or take your turn whenever.</p>
          <div className="hero-notes">
            <span><Users size={18} /> 2–4 players</span>
            <span><Clock3 size={18} /> Live or 72-hour turns</span>
          </div>
        </div>

        <div className="entry-card">
          <div className="entry-tabs" role="tablist" aria-label="Create or join a table">
            <button ref={createTabRef} id="create-table-tab" type="button" role="tab" aria-controls="table-entry-panel" aria-selected={tab === "create"} tabIndex={tab === "create" ? 0 : -1} onClick={() => setTab("create")} onKeyDown={handleTabKeyDown}>New table</button>
            <button ref={joinTabRef} id="join-table-tab" type="button" role="tab" aria-controls="table-entry-panel" aria-selected={tab === "join"} tabIndex={tab === "join" ? 0 : -1} onClick={() => setTab("join")} onKeyDown={handleTabKeyDown}>Join a table</button>
          </div>

          <form id="table-entry-panel" role="tabpanel" aria-labelledby={`${tab}-table-tab`} onSubmit={submit}>
            <label className="field-label" htmlFor="name">Your name</label>
            <input id="name" value={name} onChange={(event) => setName(event.target.value)} maxLength={20} placeholder="Ada" autoComplete="nickname" required />

            {tab === "create" ? (
              <>
                <fieldset className="mode-picker">
                  <legend>How do you want to play?</legend>
                  <label className={mode === "realtime" ? "is-active" : ""}>
                    <input type="radio" name="mode" value="realtime" checked={mode === "realtime"} onChange={() => setMode("realtime")} />
                    <Play size={20} fill="currentColor" /><span><strong>Realtime</strong><small>2-minute turns</small></span>
                  </label>
                  <label className={mode === "correspondence" ? "is-active" : ""}>
                    <input type="radio" name="mode" value="correspondence" checked={mode === "correspondence"} onChange={() => setMode("correspondence")} />
                    <Clock3 size={20} /><span><strong>Correspondence</strong><small>72-hour turns</small></span>
                  </label>
                </fieldset>
                <div className="player-count">
                  <span>Seats</span>
                  {[2, 3, 4].map((count) => (
                    <button key={count} type="button" className={maxPlayers === count ? "is-active" : ""} onClick={() => setMaxPlayers(count)}>{count}</button>
                  ))}
                </div>
                <details className="assist-policy-picker">
                  <summary>Assist rules</summary>
                  <p>Choose what players may turn on at this table.</p>
                  {ASSIST_DEFINITIONS.map((assist) => (
                    <label key={assist.id}>
                      <span><strong>{assist.label}</strong><small>{assist.description}</small></span>
                      <select
                        aria-label={`${assist.label} policy`}
                        value={assistPolicy[assist.id]}
                        onChange={(event) => setAssistPolicy((current) => ({
                          ...current,
                          [assist.id]: event.target.value as AssistPolicy,
                        }))}
                      >
                        {ASSIST_POLICIES.map((policy) => (
                          <option value={policy} key={policy}>
                            {policy === "default-on" ? "Allowed, on by default" : policy === "default-off" ? "Allowed, off by default" : "Disallowed"}
                          </option>
                        ))}
                      </select>
                    </label>
                  ))}
                </details>
              </>
            ) : (
              <>
                <label className="field-label code-label" htmlFor="room">Table name</label>
                <div className="code-input-wrap"><Copy size={18} /><input id="room" className="code-input" value={roomCode} onChange={(event) => setRoomCode(formatTableNameInput(event.target.value))} placeholder="dorky-puppet-spam" pattern={TABLE_NAME_PATTERN} maxLength={TABLE_NAME_MAX_LENGTH} autoCapitalize="none" spellCheck={false} required /></div>
              </>
            )}

            {error && <p className="form-error" role="alert">{error}</p>}
            <button className="primary-button entry-submit" type="submit" disabled={busy}>
              {busy ? "Setting the table…" : tab === "create" ? "Create table" : "Take my seat"}
              {!busy && <ArrowRight size={20} />}
            </button>
          </form>
        </div>

        <div className="hero-tiles" aria-hidden="true">
          <span className="poster-tile poster-coral">7</span>
          <span className="poster-tile poster-sun">8</span>
          <span className="poster-tile poster-ocean">9</span>
          <span className="poster-tile poster-wildcard"><CatFaceIcon /></span>
        </div>
      </section>

      {history.length > 0 && (
        <section className="history-section" aria-labelledby="saved-games-heading">
          <div className="history-heading">
            <div>
              <p className="eyebrow"><History size={15} /> Saved tables</p>
              <h2 id="saved-games-heading">Pick up where<br /><em>you left off.</em></h2>
            </div>
            <p>These tables are tied to this browser. Open one to take your seat again.</p>
          </div>
          <div className="history-grid">
            {history.map((game) => {
              const status = game.status === "finished" ? "Finished" : game.status === "playing" ? "In progress" : "Waiting to start";
              const players = game.players.map((player) => player.name).join(" · ");
              const date = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(game.updatedAt);
              return (
                <button className="history-card" type="button" key={game.id} onClick={() => onEnter(game.id)}>
                  <span className={`history-status is-${game.status}`}><i /> {status}</span>
                  <strong>{game.id}</strong>
                  <span className="history-players">{players}</span>
                  <small>{game.winnerName ? `${game.winnerName} won · ` : ""}{date}<ChevronRight size={17} /></small>
                </button>
              );
            })}
          </div>
        </section>
      )}
    </main>
  );
}
