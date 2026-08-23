import type { DragEvent, FocusEvent, KeyboardEvent, MouseEvent, PointerEvent } from "react";
import type { WildcardAssignment } from "../../shared/rules";
import type { Tile } from "../../shared/types";
import { CatFaceIcon } from "./CatFaceIcon";

interface TileViewProps {
  tile: Tile;
  selected?: boolean;
  compact?: boolean;
  disabled?: boolean;
  newActivity?: boolean;
  wildcardAssignment?: WildcardAssignment;
  wildcardOnTable?: boolean;
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
  newActivity = false,
  wildcardAssignment,
  wildcardOnTable = false,
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
  const wildcardColors = wildcardAssignment?.possibleColors ?? [];
  const wildcardDescription = wildcardAssignment
    ? wildcardAssignment.color
      ? `${wildcardAssignment.color} ${wildcardAssignment.value}`
      : `${wildcardAssignment.value} in ${wildcardColors.join(" or ")}`
    : null;

  return (
    <button
      type="button"
      data-tile-id={tile.id}
      className={`tile tile-${tile.color ?? "wildcard"} ${wildcardAssignment?.color ? `wildcard-as-${wildcardAssignment.color}` : ""} ${selected ? "is-selected" : ""} ${compact ? "is-compact" : ""} ${newActivity ? "is-new-activity" : ""}`}
      aria-label={tile.wildcard ? wildcardDescription ? `Wildcard representing ${wildcardDescription}` : wildcardOnTable ? "Unassigned wildcard" : "Wildcard tile" : `${tile.color} ${tile.value}`}
      title={tile.wildcard ? wildcardDescription ? `Wildcard = ${wildcardDescription}` : wildcardOnTable ? "Place this wildcard in a valid group or run to assign it" : "Wildcard" : undefined}
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
      <span className="tile-corner">{tile.wildcard ? "★" : tile.value}</span>
      <span className="tile-value">
        {tile.wildcard
          ? wildcardAssignment
            ? <><b className="wildcard-number">{wildcardAssignment.value}</b><CatFaceIcon className="wildcard-cat wildcard-cat-badge" /></>
            : <CatFaceIcon className="wildcard-cat" />
          : tile.value}
      </span>
      {tile.wildcard && wildcardAssignment ? (
        <span className="wildcard-colors" aria-hidden="true">
          {wildcardColors.map((color) => <i className={`wildcard-color wildcard-color-${color}`} key={color} />)}
        </span>
      ) : <span className="tile-pip" aria-hidden="true" />}
    </button>
  );
}
