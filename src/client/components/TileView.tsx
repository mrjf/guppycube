import type { DragEvent, FocusEvent, KeyboardEvent, MouseEvent, PointerEvent } from "react";
import type { WilcardAssignment } from "../../shared/rules";
import type { Tile } from "../../shared/types";
import { CatFaceIcon } from "./CatFaceIcon";

interface TileViewProps {
  tile: Tile;
  selected?: boolean;
  compact?: boolean;
  disabled?: boolean;
  newActivity?: boolean;
  wilcardAssignment?: WilcardAssignment;
  wilcardOnTable?: boolean;
  keyShortcuts?: string;
  onClick?: (event: MouseEvent<HTMLButtonElement>) => void;
  onDoubleClick?: () => void;
  onFocus?: (event: FocusEvent<HTMLButtonElement>) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLButtonElement>) => void;
  onDragStart?: (event: DragEvent<HTMLButtonElement>) => void;
  onDragEnd?: (event: DragEvent<HTMLButtonElement>) => void;
  onDrop?: (event: DragEvent<HTMLButtonElement>) => void;
  onPointerDown?: (event: PointerEvent<HTMLButtonElement>) => void;
  onPointerMove?: (event: PointerEvent<HTMLButtonElement>) => void;
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
  wilcardAssignment,
  wilcardOnTable = false,
  keyShortcuts,
  onClick,
  onDoubleClick,
  onFocus,
  onKeyDown,
  onDragStart,
  onDragEnd,
  onDrop,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  onPointerLeave,
  onContextMenu,
}: TileViewProps) {
  const wilcardColors = wilcardAssignment?.possibleColors ?? [];
  const wilcardDescription = wilcardAssignment
    ? wilcardAssignment.color
      ? `${wilcardAssignment.color} ${wilcardAssignment.value}`
      : `${wilcardAssignment.value} in ${wilcardColors.join(" or ")}`
    : null;

  return (
    <button
      type="button"
      data-tile-id={tile.id}
      className={`tile tile-${tile.color ?? "wilcard"} ${wilcardAssignment?.color ? `wilcard-as-${wilcardAssignment.color}` : ""} ${selected ? "is-selected" : ""} ${compact ? "is-compact" : ""} ${newActivity ? "is-new-activity" : ""}`}
      aria-label={tile.wilcard ? wilcardDescription ? `Wilcard representing ${wilcardDescription}` : wilcardOnTable ? "Unassigned wilcard" : "Wilcard tile" : `${tile.color} ${tile.value}`}
      title={tile.wilcard ? wilcardDescription ? `Wilcard = ${wilcardDescription}` : wilcardOnTable ? "Place this wilcard in a valid group or run to assign it" : "Wilcard" : undefined}
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
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onPointerLeave={onPointerLeave}
      onContextMenu={onContextMenu}
    >
      <span className="tile-corner">{tile.wilcard ? "★" : tile.value}</span>
      <span className="tile-value">
        {tile.wilcard
          ? wilcardAssignment
            ? <><b className="wilcard-number">{wilcardAssignment.value}</b><CatFaceIcon className="wilcard-cat wilcard-cat-badge" /></>
            : <CatFaceIcon className="wilcard-cat" />
          : tile.value}
      </span>
      {tile.wilcard && wilcardAssignment ? (
        <span className="wilcard-colors" aria-hidden="true">
          {wilcardColors.map((color) => <i className={`wilcard-color wilcard-color-${color}`} key={color} />)}
        </span>
      ) : <span className="tile-pip" aria-hidden="true" />}
    </button>
  );
}
