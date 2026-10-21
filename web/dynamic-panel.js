// Vue Nodes 1.35 snapshots native widgets when a DOM widget reports a value.
// Keep asynchronous controls inside one stable, supported DOM widget instead.
let panelSequence = 0;

export function createDynamicPanel(node, app) {
    if (!app.ui.settings.getSettingValue("Comfy.VueNodes.Enabled")) return null;

    const element = document.createElement("div");
    element.dataset.benbhControls = "";
    element.style.cssText = "display:flex;flex-direction:column;gap:6px;width:100%;padding:4px 0;color:var(--input-text);font:12px sans-serif;";
    element.addEventListener("pointerdown", (event) => event.stopPropagation());
    // Vue keys widgets by name. A reused graph node ID must not reuse a removed
    // node's mounted DOM element and callbacks (e.g. clear then create).
    const panel = node.addDOMWidget(`模型参数_${++panelSequence}`, "benbh-dynamic-controls", element, {
        serialize: false, hideOnZoom: false, getValue: () => "", setValue: () => {},
        getMinHeight: () => element.childElementCount * 34 + 8,
    });
    panel.serialize = false;
    panel.computeSize = () => [360, element.childElementCount * 34 + 8];
    const rows = new Map();

    function makeRow(widget) {
        const row = document.createElement("label");
        row.style.cssText = "display:grid;grid-template-columns:minmax(80px,auto) minmax(120px,1fr);align-items:center;gap:10px;min-height:28px;";
        const label = document.createElement("span");
        const input = document.createElement(widget.type === "combo" ? "select" : "input");
        if (widget.type !== "combo") input.type = widget.type === "toggle" ? "checkbox" : widget.type === "number" ? "number" : "text";
        input.style.cssText = "box-sizing:border-box;min-width:0;width:100%;min-height:28px;padding:4px 7px;border:1px solid var(--border-color,#555);border-radius:5px;background:var(--comfy-input-bg,#222);color:var(--input-text,#ddd);font:inherit;";
        if (input.type === "checkbox") input.style.cssText = "justify-self:end;accent-color:var(--input-text);";
        input.dataset.captureWheel = "true";
        const entry = { row, label, input, editing: false };
        input.addEventListener("input", () => { entry.editing = true; });
        input.addEventListener("change", () => {
            let value = input.type === "checkbox" ? input.checked : input.value;
            if (widget.type === "number") {
                value = Number(value);
                if (!Number.isFinite(value) || input.value === "") return;
            }
            entry.editing = false;
            widget.value = value;
            widget.callback?.(value);
        });
        row.append(label, input);
        return entry;
    }

    function render(widgets) {
        const active = new Set(widgets);
        for (const [widget, entry] of rows) {
            if (!active.has(widget)) { entry.row.remove(); rows.delete(widget); }
        }
        widgets.forEach((widget, index) => {
            let entry = rows.get(widget);
            if (!entry) { entry = makeRow(widget); rows.set(widget, entry); }
            const { row, label, input } = entry;
            label.textContent = widget.label ?? widget.name;
            input.setAttribute("aria-label", widget.name);
            input.disabled = Boolean(widget.disabled || widget.options?.disabled);
            row.title = widget.tooltip ?? "";
            if (widget.type === "combo") {
                const values = widget.options?.values ?? [];
                const current = Array.from(input.options, (option) => option.value);
                if (JSON.stringify(current) !== JSON.stringify(values)) {
                    input.replaceChildren(...values.map((value) => {
                        const option = document.createElement("option");
                        option.textContent = option.value = String(value);
                        return option;
                    }));
                }
            } else if (widget.type === "number") {
                input.min = String(widget.options.min ?? "");
                input.max = String(widget.options.max ?? "");
                input.step = String((widget.options.step ?? 10) / 10);
            }
            if (input.type === "checkbox") input.checked = Boolean(widget.value);
            else if (!(entry.editing && document.activeElement === input) && input.value !== String(widget.value ?? "")) input.value = String(widget.value ?? "");
            // Reuse controls on status/quote updates so focus and pending edits survive.
            if (element.children[index] !== row) element.insertBefore(row, element.children[index] ?? null);
        });
    }
    return { render };
}
