import React from "react";
import ReactDOM from "react-dom/server";

const REACT_ELEMENT_SYMBOLS = new Set([
    Symbol.for("react.element"),
    Symbol.for("react.transitional.element"),
]);

function check(Component, props, children) {
    if (typeof Component === "object") {
        return REACT_ELEMENT_SYMBOLS.has(Component?.$$typeof);
    }
    if (typeof Component !== "function") return false;
    if (Component.prototype != null && typeof Component.prototype.render === "function") {
        return Object.prototype.isPrototypeOf.call(React.Component, Component) ||
            Object.prototype.isPrototypeOf.call(React.PureComponent, Component);
    }
    let isReactComponent = false;
    // Match @astrojs/react: probe inside a render so hooks have a React dispatcher.
    function Tester() {
        try {
            const vnode = Component(props ?? {}, children ?? {});
            isReactComponent = REACT_ELEMENT_SYMBOLS.has(vnode?.$$typeof);
        } catch {
            // A failed probe is not evidence that this is a React component.
        }
        return React.createElement("div");
    }
    ReactDOM.renderToString(React.createElement(Tester));
    return isReactComponent;
}

function renderToStaticMarkup(Component, props) {
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
