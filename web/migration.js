const CLASS = "BenbhImageGenerate";
const removedInputs = new Set(["mode", "run_id", "control_after_generate", "resume_task_id"]);

// A browser kept open during a backend update can still hold an old node definition.
export function pruneDefinition(definition) {
    if (definition.name !== CLASS) return;
    // Backend declares spare IMAGE inputs for standard execution validation.
    // The browser reconciles visible slots with the selected model's limit.
    for (const name of Object.keys(definition.input?.optional ?? {})) {
        if (/^reference_images_\d+$/.test(name)) delete definition.input.optional[name];
    }
    if (definition.input_order?.optional) {
        definition.input_order.optional = definition.input_order.optional.filter(name => !/^reference_images_\d+$/.test(name));
    }
    for (const group of Object.values(definition.input ?? {})) {
        for (const name of removedInputs) delete group[name];
    }
    for (const [group, names] of Object.entries(definition.input_order ?? {})) {
        definition.input_order[group] = names.filter((name) => !removedInputs.has(name));
    }
    for (const key of ["output", "output_name", "output_is_list", "output_tooltips"]) {
        if (Array.isArray(definition[key])) definition[key] = definition[key].slice(0, 1);
    }
}

export function pruneWidgets(node) {
    for (let index = (node.widgets?.length ?? 0) - 1; index >= 0; index--) {
        const widget = node.widgets[index];
        if (!removedInputs.has(widget.name)) continue;
        widget.onRemove?.();
        node.widgets.splice(index, 1);
    }
    for (let index = (node.inputs?.length ?? 0) - 1; index >= 0; index--) {
        if (removedInputs.has(node.inputs[index].name)) node.removeInput(index);
    }
    for (let index = (node.outputs?.length ?? 0) - 1; index >= 1; index--) node.removeOutput(index);
}

// Old widget values were positional, including ComfyUI's generated counter policy.
export function migrateNode(node) {
    if (node.type !== CLASS) return null;
    if (Array.isArray(node.outputs)) node.outputs = node.outputs.slice(0, 1);
    const values = node.widgets_values;
    if (Array.isArray(values) && ["演示（不扣积分）", "平台 API"].includes(values[0])) {
        node.widgets_values = [values[1], values[2], values[3]];
    } else if (Array.isArray(values) && values.length === 4) {
        node.widgets_values = values.slice(0, 3);
    }
    // Retain obsolete model IDs so old test workflows require an explicit model choice.
    // Never silently turn a local test workflow into a paid generation.
    const slots = new Map();
    const inputs = node.inputs ?? [];
    node.inputs = inputs.filter((input, index) => {
        if (removedInputs.has(input.name)) { slots.set(index, null); return false; }
        slots.set(index, index - [...slots.values()].filter((v) => v === null).length);
        return true;
    });
    return slots;
}

export function migrateGraph(graph) {
    const mappings = new Map();
    const imageNodes = new Set();
    for (const node of graph.nodes ?? []) {
        const slots = migrateNode(node);
        if (slots) {
            mappings.set(String(node.id), slots);
            imageNodes.add(String(node.id));
        }
    }
    const removedLinks = new Set();
    graph.links = (graph.links ?? []).filter((link) => {
        const array = Array.isArray(link);
        const originId = array ? link[1] : link.origin_id;
        const originSlot = array ? link[2] : link.origin_slot;
        if (imageNodes.has(String(originId)) && originSlot >= 1) {
            removedLinks.add(array ? link[0] : link.id);
            return false;
        }
        const targetId = array ? link[3] : link.target_id;
        const slot = array ? link[4] : link.target_slot;
        const mapping = mappings.get(String(targetId));
        if (!mapping?.has(slot)) return true;
        const next = mapping.get(slot);
        if (next === null) { removedLinks.add(array ? link[0] : link.id); return false; }
        if (array) link[4] = next;
        else link.target_slot = next;
        return true;
    });
    for (const node of graph.nodes ?? []) {
        for (const input of node.inputs ?? []) {
            if (removedLinks.has(input.link)) input.link = null;
        }
        for (const output of node.outputs ?? []) {
            if (output.links) output.links = output.links.filter((id) => !removedLinks.has(id));
        }
    }
    for (const subgraph of graph.definitions?.subgraphs ?? []) migrateGraph(subgraph);
}
