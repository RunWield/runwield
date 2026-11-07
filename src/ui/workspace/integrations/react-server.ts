import React from "react";
import ReactDOM from "react-dom/server";

interface ReactElementMarker {
    $$typeof?: symbol;
}

interface ComponentPrototype {
    render?: () => React.ReactNode;
}

type EmptyProps = Record<string, never>;

interface ComponentProbe<Props, Slots> {
    (props: Props | EmptyProps, children: Slots | EmptyProps): React.ReactNode | ReactElementMarker;
    prototype?: ComponentPrototype;
}

const REACT_ELEMENT_SYMBOLS = new Set<symbol | undefined>([
    Symbol.for("react.element"),
    Symbol.for("react.transitional.element"),
]);

function check<Props, Slots>(Component: unknown, props: Props, children: Slots) {
    if (typeof Component === "object") {
        return REACT_ELEMENT_SYMBOLS.has((Component as ReactElementMarker | null)?.$$typeof);
    }
    if (typeof Component !== "function") return false;
    // Astro probes components from multiple renderers. React does not expose the
    // internal marker or the direct invocation contract used by this probe.
    const probe = Component as ComponentProbe<Props, Slots>;
    if (probe.prototype != null && typeof probe.prototype.render === "function") {
        return (
            Object.prototype.isPrototypeOf.call(React.Component, Component) ||
            Object.prototype.isPrototypeOf.call(React.PureComponent, Component)
        );
    }
    let isReactComponent = false;
    // Match @astrojs/react: probe inside a render so hooks have a React dispatcher.
    function Tester() {
        try {
            const vnode = probe(props ?? {}, children ?? {});
            isReactComponent = REACT_ELEMENT_SYMBOLS.has((vnode as ReactElementMarker | null | undefined)?.$$typeof);
        } catch {
            // A failed probe is not evidence that this is a React component.
        }
        return React.createElement("div");
    }
    ReactDOM.renderToString(React.createElement(Tester));
    return isReactComponent;
}

function renderToStaticMarkup<Props>(
    Component: React.ElementType,
    props: (Props & React.Attributes) | null | undefined,
) {
    const vnode = React.createElement(Component, props ?? {});
    const html = ReactDOM.renderToString(vnode);
    return { html, attrs: {} };
}

export default {
    name: "@astrojs/react",
    check,
    renderToStaticMarkup,
    supportsAstroStaticSlot: true,
};
