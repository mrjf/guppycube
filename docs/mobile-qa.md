# Mobile QA

## 2026-11-01 — phone controls, touch tiles, and player rejoin links

- Played local games in Chromium with phone and tablet input emulation. Checked
  320×568, 390×844, 430×932, 740×340 and 756×308, and inspected portrait and
  landscape screenshots. Staged tiles stayed on the felt through rotation;
  Draw and Commit stayed in the viewport. Opened and scrolled Table tools,
  toggled Activity, and checked that closing the menu restored focus.
- Tested tapping tiles onto a set, dragging from rack to set, creating a new
  set on empty felt, canceling an off-target drop, and returning a tile to the
  rack. Also tested keyboard staging and a host-issued rejoin link in a fresh
  browser context.
- Checked horizontal overflow, board/rack separation and turn-action visibility
  at widths 640/641, heights 820/821, and landscape heights 500/501. Rechecked
  at 1280×800. At 390×400, the name field accepted input and the Create table
  action remained reachable by scrolling.
- Seven native navigation tests and the WKWebView launch test passed on an
  iPhone 17 simulator (iOS 26.5). The app loaded the live game, accepted text
  through the simulator keyboard, and kept it through landscape and portrait
  rotation. No physical phone was tested.
