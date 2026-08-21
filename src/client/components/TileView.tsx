import type { DragEvent, FocusEvent, KeyboardEvent, MouseEvent, PointerEvent } from "react";
import type { JokerAssignment } from "../../shared/rules";
import type { Tile } from "../../shared/types";
import { CatFaceIcon } from "./CatFaceIcon";

interface TileViewProps {
  tile: Tile;
  selected?: boolean;
  compact?: boolean;
  disabled?: boolean;
  recentlyPlayed?: boolean;
  jokerAssignment?: JokerAssignment;
  jokerOnTable?: boolean;
  keyShortcuts?: string;
  onClick?: (event: MouseEvent<HTMLButtonElement>) => void;
  onDoubleClick?: () => void;
  onFocus?: (event: FocusEvent<HTMLButtonElement>) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLButtonElement>) => void;
  onDragStart?: (event: DragEvent<HTMLButtonElement>) => void;
  onDragEnd?: (event: DragEvent<HTMLButtonElement>) => void;
  onDrop?: (event: DragEvent<HTMLButtonElement>) => void;
  onPointerDown?: (event: PointerEvent<HTMLButtonElement>) => void;
  onPointerUp?: (event: PointerEvent<HTMLButtonElement>) => void;
  onPointerCancel?: (event: PointerEvent<HTMLButtonElement>) => void;
  onPointerLeave?: (event: PointerEvent<HTMLButtonElement>) => void;
  onContextMenu?: (event: MouseEvent<HTMLButtonElement>) => void;
}

export function TileView({
  tile,
  selected = false,
  compact = false,
  disabled = false,
  recentlyPlayed = false,
  jokerAssignment,
  jokerOnTable = false,
  keyShortcuts,
  onClick,
  onDoubleClick,
  onFocus,
  onKeyDown,
  onDragStart,
  onDragEnd,
  onDrop,
  onPointerDown,
  onPointerUp,
  onPointerCancel,
  onPointerLeave,
  onContextMenu,
}: TileViewProps) {
  const jokerColors = jokerAssignment?.possibleColors ?? [];
  const jokerDescription = jokerAssignment
    ? jokerAssignment.color
      ? `${jokerAssignment.color} ${jokerAssignment.value}`
      : `${jokerAssignment.value} in ${jokerColors.join(" or ")}`
    : null;

  return (
    <button
      type="button"
      data-tile-id={tile.id}
      className={`tile tile-${tile.color ?? "joker"} ${jokerAssignment?.color ? `joker-as-${jokerAssignment.color}` : ""} ${selected ? "is-selected" : ""} ${compact ? "is-compact" : ""} ${recentlyPlayed ? "is-remote-play" : ""}`}
      aria-label={tile.joker ? jokerDescription ? `Joker representing ${jokerDescription}` : jokerOnTable ? "Unassigned joker" : "Joker tile" : `${tile.color} ${tile.value}`}
      title={tile.joker ? jokerDescription ? `Joker = ${jokerDescription}` : jokerOnTable ? "Place this joker in a valid group or run to assign it" : "Joker" : undefined}
      aria-pressed={selected}
      aria-keyshortcuts={keyShortcuts}
      disabled={disabled}
      draggable={!disabled}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onFocus={onFocus}
      onKeyDown={onKeyDown}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={(event) => event.preventDefault()}
      onDrop={onDrop}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onPointerLeave={onPointerLeave}
      onContextMenu={onContextMenu}
    >
      <span className="tile-corner">{tile.joker ? "★" : tile.value}</span>
      <span className="tile-value">
        {tile.joker
          ? jokerAssignment
            ? <><b className="joker-number">{jokerAssignment.value}</b><CatFaceIcon className="joker-cat joker-cat-badge" /></>
            : <CatFaceIcon className="joker-cat" />
          : tile.value}
      </span>
      {tile.joker && jokerAssignment ? (
        <span className="joker-colors" aria-hidden="true">
          {jokerColors.map((color) => <i className={`joker-color joker-color-${color}`} key={color} />)}
        </span>
      ) : <span className="tile-pip" aria-hidden="true" />}
    </button>
  );
}
