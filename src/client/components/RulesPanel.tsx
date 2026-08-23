import { X } from "lucide-react";
import { useEffect, useRef } from "react";

export function RulesPanel({ onClose }: { onClose: () => void }) {
  const panelRef = useRef<HTMLElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    titleRef.current?.focus();

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !panelRef.current) return;
      const focusable = [...panelRef.current.querySelectorAll<HTMLElement>(
        'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
      )];
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) {
        event.preventDefault();
        panelRef.current.focus();
      } else if (event.shiftKey && (document.activeElement === first || !panelRef.current.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !panelRef.current.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      previouslyFocused?.focus();
    };
  }, [onClose]);

  return (
    <div className="modal-backdrop" role="presentation" onPointerDown={onClose}>
      <section ref={panelRef} className="rules-panel" role="dialog" aria-modal="true" aria-labelledby="rules-title" tabIndex={-1} onPointerDown={(event) => event.stopPropagation()}>
        <button className="icon-button rules-close" type="button" onClick={onClose} aria-label="Close rules">
          <X size={20} />
        </button>
        <p className="eyebrow">How to play</p>
        <h2 ref={titleRef} id="rules-title" tabIndex={-1}>Make the table work.</h2>
        <div className="rule-grid">
          <article><span>01</span><h3>Open with 30</h3><p>Your first play must include rack-only melds worth at least 30 points. Once they qualify, you may also remix the table in that turn.</p></article>
          <article><span>02</span><h3>Build groups</h3><p>Three or four of the same number, each in a different color.</p></article>
          <article><span>03</span><h3>Build runs</h3><p>Three or more consecutive numbers in one color. The sequence stays between 1 and 13.</p></article>
          <article><span>04</span><h3>Remix the table</h3><p>Once your opening melds qualify, split and rearrange any table melds—as long as every tile finishes in a valid meld.</p></article>
          <article><span>05</span><h3>Use wildcards</h3><p>A wildcard shows the tile it represents. After opening, free it by leaving its old set valid—then use it in a valid set that same turn. At least one rack tile must also be played.</p></article>
          <article><span>06</span><h3>Go out</h3><p>Play every tile to win. Otherwise draw one tile and end your turn. Wildcards left on a rack count 30.</p></article>
        </div>
        <section className="keyboard-guide" aria-labelledby="keyboard-guide-title">
          <div>
            <p className="eyebrow">Keyboard controls</p>
            <h3 id="keyboard-guide-title">Play without the mouse.</h3>
            <p>Tab into the tiles, then use the arrow keys to move through the table and rack.</p>
          </div>
          <dl>
            <div><dt><kbd>Space</kbd></dt><dd>Select or deselect the focused tile</dd></div>
            <div><dt><kbd>Shift</kbd> + arrows / click</dt><dd>Extend the tile selection</dd></div>
            <div><dt><kbd>Shift</kbd> + <kbd>Enter</kbd></dt><dd>Select the focused run, group, or meld</dd></div>
            <div><dt><kbd>Option</kbd>/<kbd>Alt</kbd> + <kbd>Enter</kbd></dt><dd>Make selected tiles into a new meld</dd></div>
            <div><dt><kbd>Enter</kbd></dt><dd>Move selected tiles into the focused meld</dd></div>
            <div><dt><kbd>Esc</kbd></dt><dd>Clear the selection or cancel a meld move</dd></div>
            <div><dt><kbd>⌘</kbd>/<kbd>Ctrl</kbd> + <kbd>Z</kbd></dt><dd>Undo the last table move</dd></div>
            <div><dt><kbd>⌘</kbd>/<kbd>Ctrl</kbd> + <kbd>Enter</kbd></dt><dd>Submit a valid turn</dd></div>
            <div><dt><kbd>⌘</kbd>/<kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>Enter</kbd></dt><dd>Draw and end the turn</dd></div>
          </dl>
        </section>
        <p className="rules-footnote">Realtime turns last 2 minutes. Correspondence turns last 72 hours. When the pool is empty and everyone passes, the lowest rack value wins.</p>
      </section>
    </div>
  );
}
