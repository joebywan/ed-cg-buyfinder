// Header interaction for the column tables, with plain pointer events: drag a
// header's right edge to resize (double-click to fit), drag a header to move it.
import { MIN_W, MAX_W } from "./columns.js";

// A drag ends in a click on the header, which would sort; swallow that one.
let swallow = false;
if (typeof document !== "undefined") {
  document.addEventListener("click", (e) => {
    if (swallow) { swallow = false; e.stopPropagation(); e.preventDefault(); }
  }, true);
}

const clampW = (w) => Math.min(MAX_W, Math.max(MIN_W, Math.round(w)));

/** Give `table` a <colgroup> of `widths` (px, one per th) and wire its headers.
 *  onWidth(id, px) after a resize; onMove(id, targetId, after) after a reorder. */
export function wireHeaders(table, ids, widths, { onWidth, onMove }) {
  const cols = widths.map((w) => { const c = document.createElement("col"); c.style.width = `${w}px`; return c; });
  const group = document.createElement("colgroup");
  group.append(...cols);
  table.prepend(group);
  const fit = () => { table.style.width = `${cols.reduce((n, c) => n + parseFloat(c.style.width), 0)}px`; };
  fit();
  const ths = [...table.querySelectorAll("thead th")];
  ths.forEach((th, i) => {
    th.dataset.col = ids[i];
    const grip = document.createElement("span");
    grip.className = "grip";
    grip.title = "Drag to resize; double-click to fit";
    th.append(grip);

    grip.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      e.preventDefault();
      grip.setPointerCapture(e.pointerId);
      const x0 = e.clientX, w0 = parseFloat(cols[i].style.width);
      grip.onpointermove = (m) => { cols[i].style.width = `${clampW(w0 + m.clientX - x0)}px`; fit(); };
      grip.onpointerup = () => {
        grip.onpointermove = grip.onpointerup = null;
        onWidth(ids[i], parseFloat(cols[i].style.width));
      };
    });
    grip.addEventListener("click", (e) => e.stopPropagation());
    grip.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      cols[i].style.width = `${MIN_W}px`;       // cells clip, so measure from the narrowest
      const need = Math.max(...[...table.rows].map((r) => r.cells[i]?.scrollWidth ?? 0));
      cols[i].style.width = `${clampW(need + 2)}px`;
      fit();
      onWidth(ids[i], parseFloat(cols[i].style.width));
    });

    th.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || e.target === grip) return;
      const x0 = e.clientX;
      let over = null, after = false, dragging = false;
      const clear = () => ths.forEach((t) => t.classList.remove("drop-before", "drop-after", "dragging"));
      th.onpointermove = (m) => {
        if (!dragging && Math.abs(m.clientX - x0) < 6) return;
        if (!dragging) { dragging = true; th.setPointerCapture(m.pointerId); }
        getSelection()?.removeAllRanges();
        clear();
        th.classList.add("dragging");
        over = document.elementFromPoint(m.clientX, m.clientY)?.closest("thead th[data-col]");
        if (!over || over === th) { over = null; return; }
        const r = over.getBoundingClientRect();
        after = m.clientX > r.left + r.width / 2;
        over.classList.add(after ? "drop-after" : "drop-before");
      };
      th.onpointerup = () => {
        th.onpointermove = th.onpointerup = null;
        clear();
        if (!dragging) return;
        swallow = true;
        setTimeout(() => { swallow = false; }, 50);
        if (over) onMove(ids[i], over.dataset.col, after);
      };
    });
  });
}
