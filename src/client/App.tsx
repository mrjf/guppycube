import { useCallback, useEffect, useState } from "react";
import type { GameSession } from "../shared/types";
import { normalizeTableName, TABLE_NAME_SEGMENT_PATTERN } from "../shared/table-name";
import { appPath, stripAppBase } from "./base-path";
import { Game } from "./components/Game";
import { Home } from "./components/Home";
import { RulesPanel } from "./components/RulesPanel";

function roomFromPath(): string | null {
  const pattern = new RegExp(`^/room/(${TABLE_NAME_SEGMENT_PATTERN})/?$`, "i");
  const match = stripAppBase(window.location.pathname).match(pattern);
  return match?.[1] ? normalizeTableName(match[1]) : null;
}

interface NavigationState {
  session: GameSession | null;
  roomToJoin: string;
}

function initialNavigation(): NavigationState {
  const pathRoom = roomFromPath();
  return {
    session: pathRoom ? { roomCode: pathRoom } : null,
    roomToJoin: pathRoom ?? "",
  };
}

export default function App() {
  const [{ session, roomToJoin }, setNavigation] = useState(initialNavigation);
  const [rulesOpen, setRulesOpen] = useState(false);

  useEffect(() => {
    if (session && !roomFromPath()) {
      window.history.replaceState({}, "", appPath(`/room/${session.roomCode}`));
    }
  }, [session]);

  function enter(roomCode: string) {
    window.history.pushState({}, "", appPath(`/room/${roomCode}`));
    setNavigation({ session: { roomCode }, roomToJoin: roomCode });
  }

  function exit() {
    window.history.pushState({}, "", appPath("/"));
    setNavigation({ session: null, roomToJoin: "" });
  }

  const sessionMissing = useCallback((roomCode: string) => {
    setNavigation({ session: null, roomToJoin: roomCode });
  }, []);

  return (
    <>
      {session ? (
        <Game
          session={session}
          onExit={exit}
          onSessionMissing={sessionMissing}
          onShowRules={() => setRulesOpen(true)}
        />
      ) : (
        <Home initialRoom={roomToJoin} onEnter={enter} onShowRules={() => setRulesOpen(true)} />
      )}
      {rulesOpen && <RulesPanel onClose={() => setRulesOpen(false)} />}
    </>
  );
}
