import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const stylesPath = fileURLToPath(new URL("../src/client/styles.css", import.meta.url));

test("draws the felt drop highlight internally without changing its size", async ({ page }) => {
  const styles = (await readFile(stylesPath, "utf8")).replace(/^@import[^;]+;/, "");
  await page.setContent(`
    <style>${styles}</style>
    <section class="table-surface is-open-drop-target" style="width: 640px; height: 360px"></section>
  `);

  const felt = page.locator(".table-surface");
  const before = await felt.boundingBox();
  await felt.evaluate((element) => element.classList.add("has-selected-tile"));
  const after = await felt.boundingBox();
  const chrome = await felt.evaluate((element) => {
    const surface = getComputedStyle(element);
    const highlight = getComputedStyle(element, "::after");
    return {
      surfaceBorderWidths: [surface.borderTopWidth, surface.borderRightWidth, surface.borderBottomWidth, surface.borderLeftWidth],
      highlightBorderWidths: [highlight.borderTopWidth, highlight.borderRightWidth, highlight.borderBottomWidth, highlight.borderLeftWidth],
      highlightPosition: highlight.position,
    };
  });

  expect(after).toEqual(before);
  expect(chrome.surfaceBorderWidths).toEqual(["0px", "0px", "0px", "0px"]);
  expect(chrome.highlightBorderWidths).toEqual(["3px", "3px", "3px", "3px"]);
  expect(chrome.highlightPosition).toBe("absolute");
});

test("keeps the felt fixed when drag actions appear in the rack", async ({ page }) => {
  const styles = (await readFile(stylesPath, "utf8")).replace(/^@import[^;]+;/, "");
  await page.setContent(`
    <style>${styles}</style>
    <main class="game-shell" style="position: relative; inset: auto; width: 800px; height: 600px">
      <div class="table-layout">
        <section class="table-surface is-open-drop-target"></section>
      </div>
      <section class="rack-zone">
        <div class="rack-heading">
          <div class="rack-tools">
            <div class="rack-sort-tools" aria-label="Rack sorting">
              <button type="button">Color → 123</button>
              <button type="button">123 → Color</button>
            </div>
            <div class="rack-action-tools" aria-label="Turn actions">
              <button type="button">Draw</button>
              <button type="button">Commit</button>
            </div>
          </div>
        </div>
      </section>
    </main>
  `);

  const felt = page.locator(".table-surface");
  const before = await felt.boundingBox();
  await page.locator(".rack-sort-tools").evaluate((element) => {
    element.insertAdjacentHTML("beforeend", `
      <div class="selection-actions" aria-label="Selection actions">
        <button type="button">New set</button>
        <button type="button">Clear selection</button>
      </div>
    `);
    document.querySelector(".table-surface")?.classList.add("has-selected-tile");
  });
  const after = await felt.boundingBox();

  expect(after).toEqual(before);
});
