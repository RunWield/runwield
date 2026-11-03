import {
    createCodemodeExtension,
    type ExtensionFactory,
    type ModelRegistry,
    type SessionManager,
} from "@earendil-works/pi-coding-agent";

/** Keep upstream execution while attributing each auxiliary model request to its actual model. */
export function createRunWieldCodemodeExtension(sessionManager: SessionManager): ExtensionFactory {
    return (pi) =>
        createCodemodeExtension()({
            ...pi,
            registerTool: (tool) =>
                pi.registerTool({
                    ...tool,
                    async execute(id, params, signal, onUpdate, ctx) {
                        const registry = ctx.modelRegistry;
                        const classify: ModelRegistry["classify"] = async (model, context, options) => {
                            const result = await registry.classify(model, context, options);
                            if (result.usage)
                                sessionManager.appendUsage("codemode", model.provider, model.id, result.usage);
                            return result;
                        };
                        const generateImages: ModelRegistry["generateImages"] = async (model, context, options) => {
                            const result = await registry.generateImages(model, context, options);
                            if (result.usage)
                                sessionManager.appendUsage("codemode", model.provider, model.id, result.usage);
                            return result;
                        };
                        const modelRegistry = new Proxy(registry, {
                            get(target, key) {
                                if (key === "classify") return classify;
                                if (key === "generateImages") return generateImages;
                                const value = Reflect.get(target, key, target);
                                return typeof value === "function" ? value.bind(target) : value;
                            },
                        });
                        const context = new Proxy(ctx, {
                            get(target, key) {
                                return key === "modelRegistry" ? modelRegistry : Reflect.get(target, key, target);
                            },
                        });
                        const result = await tool.execute(id, params, signal, onUpdate, context);
                        // Each request already has a durable UsageEntry; the aggregate must not count again.
                        const { usage: _aggregateUsage, ...output } = result;
                        return output;
                    },
                }),
        });
}
