import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";

const CLASS = "BenbhPointsQuery";
function removeLegacyOutputs(graph) {
    const queries = new Set((graph.nodes ?? []).filter(node => node.type === CLASS).map(node => String(node.id)));
    const removed = new Set();
    graph.links = (graph.links ?? []).filter(link => {
        if (!queries.has(String(Array.isArray(link) ? link[1] : link.origin_id))) return true;
        removed.add(Array.isArray(link) ? link[0] : link.id);
        return false;
    });
    for (const node of graph.nodes ?? []) {
        if (queries.has(String(node.id))) node.outputs = [];
        for (const input of node.inputs ?? []) if (removed.has(input.link)) input.link = null;
    }
    for (const subgraph of graph.definitions?.subgraphs ?? []) removeLegacyOutputs(subgraph);
}

const chain = (target, name, callback) => {
    const original = target[name];
    target[name] = function (...args) {
        const result = original?.apply(this, args);
        callback.apply(this, args);
        return result;
    };
};

app.registerExtension({
    name: "Benbh.Bridge.PointsQuery",
    beforeConfigureGraph(graph) { removeLegacyOutputs(graph); },
    beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== CLASS) return;
        nodeData.description = "查询当前 API Key 所属账号的可用积分。点击运行时重新查询，不消耗积分。";
        for (const key of ["output", "output_name", "output_is_list", "output_tooltips"]) {
            if (Array.isArray(nodeData[key])) nodeData[key] = [];
        }
        chain(nodeType.prototype, "onConfigure", function () {
            for (let index = this.outputs.length - 1; index >= 0; index--) this.removeOutput(index);
        });
        chain(nodeType.prototype, "onNodeCreated", function () {
            const element = document.createElement("div");
            element.dataset.benbhPoints = "";
            element.style.cssText = "box-sizing:border-box;width:100%;height:100%;overflow:auto;padding:10px;white-space:pre-wrap;font:13px/1.8 sans-serif;color:var(--input-text);user-select:text;";
            element.textContent = "可用积分：待查询";
            const widget = this.addDOMWidget("积分余额", "benbh-points-result", element, {
                serialize: false, hideOnZoom: false, getValue: () => "", setValue: () => {}, getMinHeight: () => 60,
            });
            widget.serialize = false;
            widget.computeSize = () => [250, 60];
            this._benbhPointsShow = message => { element.textContent = message; this.setDirtyCanvas(true, true); };
            this.setSize([Math.max(270, this.size[0]), Math.max(110, this.computeSize()[1])]);
        });
        chain(nodeType.prototype, "onExecuted", function (message) {
            const total = message?.balances?.[0]?.total_points;
            const date = new Date(message?.queried_at?.[0]);
            if (total == null || typeof total === "boolean" || String(total).trim() === "" || !Number.isFinite(Number(total)) || !Number.isFinite(date.getTime())) {
                this._benbhPointsShow?.("查询结果格式异常，请重新运行查询。");
                return;
            }
            this._benbhPointsShow?.(`可用积分：${Number(total).toLocaleString("zh-CN", {maximumFractionDigits: 2})}\n查询时间：${date.toLocaleString("zh-CN", {hour12: false})}`);
        });
    },
    setup() {
        api.addEventListener("benbh-bridge-points-status", ({detail}) => {
            const node = app.graph?._nodes?.find(node => node.type === CLASS && String(node.id) === String(detail.node_id));
            node?._benbhPointsShow?.(detail.message);
        });
    },
});
