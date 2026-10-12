#!/usr/bin/env bun
import { readdir as fsReaddir, readFile as fsReadFile, writeFile as fsWriteFile } from "node:fs/promises";
import process from "node:process";

/**
 * Ratchet for test-injection seams.
 *
 * A seam — an entry in a module's `__deps`/`__testDeps` bag — is a public claim that
 * something is not ours. That makes it an architectural statement, not a testing
 * convenience, and it needs the same guard rails as the JS-to-TS baseline: freeze
 * where we are, refuse to slide back, tighten as each module is refactored.
 *
 * Three rules, in descending strictness:
 *
 * 1. No new conditional seams. `__deps ? fake : real` makes a module's behaviour
 *    depend on whether *anything at all* was injected, so injecting a clock can
 *    silently disable a transaction. Nothing at the call site shows it and coverage
 *    still counts the lines as run. Existing conditionals exposed by a detector fix
 *    are recorded by collaborator and occurrence, then may only shrink.
 *
 * 2. No new machinery seams. RunWield's own state machine — Plan writes, lifecycle
 *    transitions, registry writes, locks — must never be replaceable. A guarantee
 *    that only exists when components compose cannot be tested with the composing
 *    part removed. Existing ones are listed per file and may only shrink.
 *
 * 3. The seam set may only shrink. Thirty-eight injectables in one module is not a
 *    testability achievement; it is an unmade design decision deferred into the test
 *    bag. Every seam is recorded by name, so a module cannot trade one for another at a
 *    flat count, and a module absent from the baseline may not introduce any.
 *
 * Run with `--update` after removing seams to tighten the baseline. It refuses to
 * loosen: an update that would raise a count or add a machinery seam fails, so
 * "just re-baseline it" is not an escape hatch.
 *
 * Nor is editing this file. The detectors below are all scar tissue from seams that
 * changed shape rather than going away — a rename on destructure, an alias through a
 * local, an optional bag retyped as a `Port`. If a seam you introduced is caught here,
 * the fix is in the module, not in this scan: narrowing a pattern or widening a skip
 * list leaves the module exactly as replaceable as it was and only removes the reader's
 * ability to see it. Only change this script when it is wrong about the design rule
 * itself — which means it flags something that is genuinely a required external port.
 *
 * Renaming a seam looks like removing one and adding another, which the ratchet is
 * right to reject. Declare it instead:
 *
 *     bun scripts/check-injection-seams.js --update --rename old=new
 *
 * A rename rewrites the name in the baseline before comparing, so it can carry an
 * existing seam to a new name but can never introduce one — the old name has to be
 * there already.
 *
 * Splitting a module moves seams between files, which looks like a removal in one
 * and an addition in the other. Declare the move:
 *
 *     bun scripts/check-injection-seams.js --update --move src/a.js:name=src/b.ts
 *
 * A move relocates a seam already recorded against the source module before
 * comparing, so it can carry an existing seam to a new home but can never
 * introduce one — the seam has to be in the source entry already, and the total
 * cannot rise.
 *
 * When the scan itself is fixed, modules and seam spellings it could never see before
 * appear all at once and look exactly like regressions. Adopt them explicitly:
 *
 *     bun scripts/check-injection-seams.js --update --adopt-newly-visible
 *
 * This is only ever correct in the same change as a detection fix. It records newly
 * visible modules and newly visible seams inside known modules, then puts both under
 * the same shrink-only rule as the rest. Without the flag, either kind of growth is
 * still rejected.
 */

import { dirname } from "node:path";
import { fileURLToPath as fromFileUrl } from "node:url";
import { listCiFiles } from "./ci-files.ts";

const BASELINE_PATH = new URL("./injection-seam-baseline.json", import.meta.url);
const REPO_ROOT = dirname(dirname(fromFileUrl(import.meta.url)));
const SOURCE_ROOT = new URL("../src/", import.meta.url);
const SCRIPTS_ROOT = new URL("./", import.meta.url);
const PRODUCTION_ROOTS = Object.freeze([
    { rootUrl: SOURCE_ROOT, pathPrefix: "src" },
    { rootUrl: SCRIPTS_ROOT, pathPrefix: "scripts" },
]);
const SCAN_EXCLUDED_PATHS = new Set(["scripts/check-injection-seams.js"]);
const SKIP_DIRS = new Set([
    ".astro",
    ".vite",
    "_fresh",
    "coverage",
    "dist",
    "node_modules",
    "__fixtures__",
    "__tests__",
    "fixtures",
    "test-fixtures",
    "tests",
]);
const TEST_FILE_PATTERN = /(?:^|[._-])(?:test|spec)(?:\.|$)|_test\./;
const SOURCE_FILE_PATTERN = /\.(?:[jt]sx?|mjs|mts)$/;

/**
 * Names that must never sit behind a seam.
 *
 * Matched as whole injectable names, so `recordPlanEvent` is caught while an
 * unrelated `recordPlanEventMetric` would not be. Prefix entries end in `*`.
 */
/**
 * A parameter or property annotated as a dependency bag: `deps: LoadPlanTestDeps`.
 *
 * `…Ports` counts too. Renaming the bag does not change what it is, and a split
 * that introduced `ports?.name || realName` proved the point — the shape survived
 * the rename intact. Whether it is a bag is decided by `isOverrideBagType`, not by
 * the noun: an all-required port set passes, an all-optional override bag does not.
 *
 * Global-flagged regexes carry `lastIndex`, so this is rebuilt per use rather than
 * shared; the constant is the pattern, not a live matcher.
 */
const OVERRIDE_TYPE_SUFFIX = "(?:Deps|Dependencies|Ports|Port|Overrides)";
const NESTED_OVERRIDE_PROPERTY_SUFFIX = "(?:Deps|Ports?|Overrides)";
const DEPS_PARAMETER_SOURCE = `([A-Za-z_$][\\w$]*)\\s*\\??\\s*:\\s*([A-Za-z_$][\\w$]*${OVERRIDE_TYPE_SUFFIX})\\b`;

const MACHINERY_SEAMS = [
    "recordPlanEvent",
    "updatePlanFrontMatter",
    "updatePlanStatus",
    "updateArchivedPlanFrontMatter",
    "savePlan",
    "saveChildFeaturePlans",
    "writePlanMarkdownWithRevision",
    "withPlanLock",
    "withPlanCatalogLock",
    "withWorktreeRegistryLock",
    "addWorktreeRegistryEntry",
    "updateWorktreeRegistryEntry",
    "removeWorktreeRegistryEntry",
    "reconcileEntryIdentity",
    "pruneEntry",
    "run*Transition",
    "markActiveWorktreeStatus",
    "ensureExecutionPlanFile",
    "captureWorktreeTree",
    "prepareTargetBranchRef",
    // Worktree *policy*, not Git. These have Git-sounding names and call Git, but each
    // one encodes a RunWield decision: mergeExecutionWorktree proves a sealed candidate
    // and enforces allowed dirty paths, while sealing is checkpoint policy. Replacing them in
    // a test replaces the behaviour under test. The genuine Git boundary is GitPort
    // (src/shared/git-port.ts); everything here is ours.
    "mergeExecutionWorktree",
    "checkpointExecutionWorktree",
    "createWorktreeGitArtifacts",
    "settleWorktreeAttempt",
    "removeWorktreeGitArtifacts",
    "deleteMergedWorktreeBranch",
    "verifyPostMergeCandidatePublished",
    "assertPreMergeCandidateUnchanged",
    "stageValidationPassedInExecutionWorktree",
    "finalizePlanImplementation",
    "autoGenerateWorkRecordForCompletedPlan",
    "syncWorkRecordToIndex",
    "listWorkRecords",
    "ensureRootAgentSession",
    "createAgentHandler",
    "getRootSessionSwitchState",
    "switchActiveAgent",
    "runRootTurn",
    "runPrompt",
    "buildAgentSession",
    "attachSessionEventSubscribers",
    "getWorkflowDiff",
    "loadReviewerPrompt",
    "loadReviewerFeedbackEngineerDef",
    "_agentDefOverride",
];

/** @param {string} path */
function toPosixPath(path) {
    return path.replaceAll("\\", "/");
}

/** @param {string} relativePath */
function isProductionSourcePath(relativePath) {
    const normalized = toPosixPath(relativePath);
    if (!SOURCE_FILE_PATTERN.test(normalized)) return false;
    const parts = normalized.split("/");
    const fileName = parts.at(-1) || "";
    if (TEST_FILE_PATTERN.test(fileName)) return false;
    return !parts.some((part) => SKIP_DIRS.has(part));
}

/** @param {string} name */
export function isMachinerySeam(name) {
    const normalizedName = /^_(?:buildAgentSession|attachSessionEventSubscribers|runPrompt)$/.test(name)
        ? normalizeCollaboratorName(name)
        : name;
    return MACHINERY_SEAMS.some((pattern) => {
        // `*` stands for any run of characters, wherever it appears. The previous
        // version only understood a trailing `*`, so `run*Transition` fell through to
        // an equality test and matched nothing — the rule meant to forbid injecting a
        // transaction never once fired, and `runImplementationCheckpointTransition`
        // sat behind a seam under a green ratchet.
        if (!pattern.includes("*")) return normalizedName === pattern;
        const escaped = pattern.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*");
        return new RegExp(`^${escaped}$`).test(normalizedName);
    });
}

/**
 * Compare a local override binding with the implementation it falls back to.
 * `_buildAgentSession`, `buildAgentSessionFn`, and `buildAgentSessionImpl` are
 * the same collaborator wearing different call-site conventions.
 *
 * @param {string} name
 */
function normalizeCollaboratorName(name) {
    return name.replace(/^_+/, "").replace(/(?:Fn|Impl|Override)$/g, "");
}

/**
 * Whether a same-name fallback plausibly substitutes behavior rather than data.
 * Structural matching sees both `options.runTurn || runTurn` and
 * `resource.planId || attrs.planId`; only the first is an injection seam. Explicit
 * bags are still exhaustive. This predicate is only for ordinary option/member
 * fallbacks where the behavioral shape must carry the evidence.
 *
 * @param {string} name
 */
function isBehavioralCollaborator(name) {
    if (isMachinerySeam(name)) return true;
    const normalized = normalizeCollaboratorName(name);
    if (isMachinerySeam(normalized)) return true;
    if (/^[A-Z][A-Za-z0-9_$]*(?:Ctor)?$/.test(normalized)) return true;
    return /^(?:abort|append|apply|attach|build|check|checkpoint|clear|close|collect|complete|compute|connect|create|delete|detect|dispatch|dispose|emit|ensure|execute|exit|fetch|finalize|find|format|generate|get|handle|install|invoke|list|load|make|mark|merge|notify|now|open|parse|prepare|probe|prompt|publish|query|read|record|refresh|reload|remove|render|report|request|reset|resolve|restore|resume|run|save|schedule|seal|send|set|settle|show|spawn|stage|start|steer|stop|store|submit|subscribe|switch|sync|teardown|track|update|validate|verify|wait|warn|watch|write)(?:$|[A-Z0-9_$])/
        .test(normalized);
}

/**
 * Whether a default expression substitutes an implementation rather than supplying data.
 *
 * Only consulted once the parameter name already looks behavioral, so this is the
 * second half of the evidence, not the whole of it. `SCREAMING_SNAKE` names are the
 * project's spelling for constants (`runtimeTools = DEFAULT_RUNTIME_TOOLS` is a tool
 * list, not an injected collaborator), and a literal cannot be an implementation at all.
 *
 * @param {string} expression
 */
function isImplementationDefault(expression) {
    const name = finalMemberName(expression);
    if (/^(?:true|false|null|undefined|NaN|Infinity|await|new|typeof)$/.test(name)) return false;
    if (/^[A-Z0-9_$]+$/.test(name)) return false;
    return /^[A-Za-z_$][\w$]*$/.test(name);
}

/**
 * Whether a parameter default replaces behavior, by any of three signals.
 *
 * The same-name test (`probeGitRepository = probeGitRepositoryFn`) was the only one
 * for a while, which made "give the implementation a different name" a working way to
 * disappear from this scan without changing a line of behavior — `notifyRunWieldEvent =
 * notifyRunWieldEventQuietly` sat unseen on exactly that technicality. So a behavioral
 * name defaulting to any implementation counts now, and a machinery name counts however
 * it is spelled.
 *
 * The broad rule is deliberately not applied to destructures of an already-required
 * dependency parameter (`const { restoreTitle = defaultRestoreTitle } = deps`). That is
 * constructor injection with a convenience default — the shape this check tells people
 * to migrate *to* — and flagging it would punish the fix. Callers pass `broad: false`
 * there.
 *
 * @param {string} property Declared member or parameter name.
 * @param {string} local Local binding it lands in.
 * @param {string} implementation Default expression.
 * @param {boolean} broad Whether the different-name rule applies at this position.
 */
function substitutesImplementation(property, local, implementation, broad) {
    if (isMachinerySeam(normalizeCollaboratorName(property))) return true;
    if (!isBehavioralCollaborator(property)) return false;
    if (normalizeCollaboratorName(local) === normalizeCollaboratorName(implementation)) return true;
    return broad && isImplementationDefault(implementation);
}

/** @param {string} expression */
function finalMemberName(expression) {
    return expression.trim().split(/\s*(?:\?\.|\.)\s*/).at(-1) || "";
}

/**
 * A name that reads as the production implementation of a capability:
 * `SYSTEM_BROWSER_PORT`, `systemLocalCIPort`, `defaultCommandRegistry`,
 * `createGitPort`.
 */
const CAPABILITY_IMPLEMENTATION = /^(?:(?:SYSTEM|DEFAULT)_[A-Z0-9_]+|(?:system|default|create)[A-Z][\w$]*)$/;

/**
 * An implementation named as a capability rather than a value: `SYSTEM_BROWSER_PORT`,
 * `DEFAULT_GITHUB_CLI`, `defaultCommandRegistry`, `createRemoteWorkspaceAdapter`.
 *
 * This is a list of nouns, which is usually the weak kind of rule — it is here only
 * because it is checked against the *implementation's* name, where the project already
 * spells out what the thing is. `DEFAULT_WAIT_TIMEOUT_MS` is a number and says so.
 */
const CAPABILITY_NAMED = /(?:PORT|Port|CLI|Cli|CLIENT|Client|REGISTRY|Registry|ADAPTER|Adapter)$/;

/**
 * Ports handed a production default through a fallback.
 *
 * Three spellings of one shape, all requiring the implementation to be passed *whole* —
 * a bare identifier or a factory call, never a field read. `DEFAULT_FRONT_MATTER.summary`
 * reaches into a constant for a value, which is data with a default; `SYSTEM_BROWSER_PORT`
 * is a capability with a fallback. Without that distinction the front-matter defaults all
 * over plan-store.js would land in the baseline as imaginary seams.
 *
 * @param {string} text Comment-free source.
 * @returns {string[]}
 */
function collectCapabilityFallbacks(text) {
    /** @type {string[]} */
    const found = [];
    for (const override of text.matchAll(/\.\s*(_agentDefOverride)\b/g)) found.push(override[1]);
    /** @param {string} name Local binding the fallback lands in. */
    const isInvoked = (name) =>
        new RegExp(`\\b${name}\\s*(?:\\(|(?:\\?\\.|\\.)\\s*[A-Za-z_$][\\w$]*\\s*\\()`).test(text);

    // Any position: `X.prop || SYSTEM_PROP_PORT`. Where the capability is used decides
    // nothing — a port passed straight into a call (`run(argv, options.sessionPort ||
    // DEFAULT_SESSION_PORT)`) is the same seam as one bound to a local first, and an
    // earlier version that keyed on the surrounding syntax missed exactly those.
    for (
        const fallback of text.matchAll(
            /[A-Za-z_$][\w$]*\s*(?:\?\.|\.)\s*([A-Za-z_$][\w$]*)\s*(?:\|\||\?\?)\s*([A-Za-z_$][\w$]*)\s*(?![.\w])/g,
        )
    ) {
        const [, property, implementation] = fallback;
        if (CAPABILITY_IMPLEMENTATION.test(implementation) && CAPABILITY_NAMED.test(implementation)) {
            found.push(property);
        }
    }

    // A capability whose implementation is not named like one still counts when the
    // binding it lands in is invoked. `defaultCommandRegistry` happens to end in a noun
    // this recognizes; the next one will not, and calling it is the durable evidence.
    for (
        const fallback of text.matchAll(
            /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*[A-Za-z_$][\w$]*\s*(?:\?\.|\.)\s*([A-Za-z_$][\w$]*)\s*(?:\|\||\?\?)\s*([A-Za-z_$][\w$]*)\s*(?![.\w])/g,
        )
    ) {
        const [, binding, property, implementation] = fallback;
        if (CAPABILITY_IMPLEMENTATION.test(implementation) && isInvoked(binding)) found.push(property);
    }

    // `await (options.browser || SYSTEM_BROWSER).open(url)` — invoked in place, so the
    // pattern itself carries the evidence and there is no binding to look up.
    //
    // The lookbehind is what makes it mean that. Without it, an argument list reads the
    // same way: in `waitForIdle?.(scenario.timeoutMs || DEFAULT_WAIT_TIMEOUT_MS).catch(…)`
    // the parens belong to the call and `.catch` chains off its result, so a timeout in
    // milliseconds was recorded as an injected capability being invoked.
    for (
        const fallback of text.matchAll(
            /(?<![\w$)\].])\(\s*[A-Za-z_$][\w$]*\s*(?:\?\.|\.)\s*([A-Za-z_$][\w$]*)\s*(?:\|\||\?\?)\s*([A-Za-z_$][\w$]*)\s*\)\s*(?:\?\.|\.)\s*[A-Za-z_$][\w$]*\s*\(/g,
        )
    ) {
        if (CAPABILITY_IMPLEMENTATION.test(fallback[2])) found.push(fallback[1]);
    }

    // Callable options also hide behind inline implementations. Invocation of the
    // resulting binding proves this is behavior, while the behavioral property name
    // keeps ordinary data transforms out of the scan.
    for (
        const fallback of text.matchAll(
            /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*[A-Za-z_$][\w$]*\s*(?:\?\.|\.)\s*([A-Za-z_$][\w$]*)\s*(?:\|\||\?\?)\s*\(+\s*(?:async\s*)?\(?[^=;\n]*\)?\s*=>/g,
        )
    ) {
        const [, binding, property] = fallback;
        if (isBehavioralCollaborator(property) && isInvoked(binding)) found.push(property);
    }

    // An optional concrete collaborator is still replaceable when its fallback is
    // constructed inline. Native containers remain ordinary data defaults.
    const nativeDataConstructors = new Set([
        "Array",
        "Date",
        "Map",
        "Object",
        "RegExp",
        "Set",
        "URL",
        "WeakMap",
        "WeakSet",
    ]);
    for (
        const fallback of text.matchAll(
            /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*[A-Za-z_$][\w$]*\s*(?:\?\.|\.)\s*([A-Za-z_$][\w$]*)\s*(?:\|\||\?\?)\s*new\s+([A-Za-z_$][\w$]*)\s*\(/g,
        )
    ) {
        const [, binding, property, constructorName] = fallback;
        if (!nativeDataConstructors.has(constructorName) && isInvoked(binding)) found.push(property);
    }
    for (
        const fallback of text.matchAll(
            /this\s*\.\s*#?([A-Za-z_$][\w$]*)\s*=\s*[A-Za-z_$][\w$]*\s*(?:\?\.|\.)\s*([A-Za-z_$][\w$]*)\s*(?:\|\||\?\?)\s*new\s+([A-Za-z_$][\w$]*)\s*\(/g,
        )
    ) {
        const [, binding, property, constructorName] = fallback;
        if (!nativeDataConstructors.has(constructorName) && isInvoked(binding)) found.push(property);
    }
    return found;
}

/**
 * Variables replaced by an explicitly test-only setter/resetter.
 * Cache-only reset functions take no replacement argument and therefore add
 * nothing; this finds actual behavior substitution without punishing cleanup.
 *
 * @param {string} text Comment-free source.
 * @returns {string[]}
 */
function collectTestHookAssignments(text) {
    const assigned = [];
    const hook = /export\s+function\s+__(?:set|reset)[A-Za-z_$][\w$]*Tests?\s*\(([^)]*)\)\s*\{/g;
    for (const match of text.matchAll(hook)) {
        const params = new Set(
            match[1].split(",").map((part) => part.trim().match(/^([A-Za-z_$][\w$]*)/)?.[1]).filter(Boolean),
        );
        if (params.size === 0) continue;
        const open = (match.index || 0) + match[0].lastIndexOf("{");
        let depth = 0;
        let close = text.length;
        for (let cursor = open; cursor < text.length; cursor++) {
            if (text[cursor] === "{") depth++;
            if (text[cursor] === "}") depth--;
            if (depth === 0) {
                close = cursor;
                break;
            }
        }
        const body = text.slice(open + 1, close);
        for (const assignment of body.matchAll(/\b([A-Za-z_$][\w$]*)\s*=\s*([^;\n]+)/g)) {
            const rhs = assignment[2];
            if ([...params].some((param) => new RegExp(`\\b${param}\\b`).test(rhs))) assigned.push(assignment[1]);
        }
    }
    return assigned;
}

/**
 * Machinery named in an options/interface shape is injectable even when the
 * caller is forced to supply it. Required arguments are the right shape for a
 * genuine external port, not permission to replace RunWield transactions.
 *
 * @param {string} text Original source, including JSDoc.
 * @returns {string[]}
 */
function collectDeclaredMachinery(text) {
    const names = new Set();
    for (
        const declaration of text.matchAll(
            /(?:interface|type)\s+[A-Za-z_$][\w$]*(?:\s*<[^>]+>)?[^\{=]*(?:=\s*)?\{([^}]*)\}/g,
        )
    ) {
        for (const member of declaration[1].matchAll(/^\s*([A-Za-z_$][\w$]*)\s*\??\s*:/gm)) {
            if (isMachinerySeam(member[1])) names.add(member[1]);
        }
    }
    for (const property of text.matchAll(/@(property|param)\s+\{[^}]+\}\s+\[?([A-Za-z_$][\w$]*)/g)) {
        if (isMachinerySeam(property[2])) names.add(property[2]);
    }
    return [...names];
}

/**
 * Injectable names a module reads out of its dependency bag.
 *
 * Reads the source text rather than the module graph on purpose: the point is to
 * see the declared seams, and a text scan cannot be defeated by indirection that
 * would also defeat a reviewer.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function collectSeamNames(text) {
    const scannedText = blankComments(text);
    /** @type {Set<string>} */
    const names = new Set();
    /**
     * @param {string} bag A source expression naming the dependency bag.
     */
    const collectFromBag = (bag) => {
        const source = bag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        // Member reads: `bag.name`, `bag?.name`.
        //
        // The bag name must start a word. Without that, a bag called `deps` matches
        // inside the module specifier `"./load-plan-test-deps.ts"` and invents a seam
        // named `ts` — a filename, not something anyone injects.
        for (
            const read of scannedText.matchAll(
                new RegExp(`(?<![\\w$-])${source}\\s*(?:\\?\\.|\\.)\\s*([A-Za-z_$][\\w$]*)`, "g"),
            )
        ) {
            names.add(read[1]);
        }
        // Destructured reads: `const { a, b: bLocal } = bag`. The declared name is the
        // left of the colon — renaming the local binding does not rename the seam.
        for (
            const block of scannedText.matchAll(
                new RegExp(`(?:const|let)\\s*\\{([^}]*)\\}\\s*=\\s*${source}\\b`, "g"),
            )
        ) {
            for (const part of block[1].split(",")) {
                const name = part.split(":")[0].trim().replace(/^\.\.\./, "");
                if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
            }
        }
    };

    collectFromBag("__deps");
    collectFromBag("__testDeps");
    collectFromBag("__Deps");
    collectFromBag("options.__deps");
    collectFromBag("options.__testDeps");
    if (declaresOptionalFallbackPorts(scannedText)) collectFromBag("ports");

    // The old bag also appears under ordinary nouns, especially in JSDoc modules:
    // `deps = {}` and `dependencies = {}`. These names are unambiguous at a default
    // empty-object boundary; data-merging `overrides = {}` is deliberately excluded.
    for (const bag of scannedText.matchAll(/\b(deps|dependencies)\s*=\s*\{\}/gi)) {
        collectFromBag(bag[1]);
    }

    // Module-global test registries (`let clipboardDeps = defaultClipboardDeps`) are
    // bags too. A test setter mutates process-wide behavior, which is more dangerous
    // than an argument-local override because leakage crosses test and Session bounds.
    for (
        const bag of scannedText.matchAll(
            /(?:let|var)\s+([A-Za-z_$][\w$]*(?:Deps|Dependencies))\s*=\s*[A-Za-z_$][\w$]*(?:Deps|Dependencies)\b/g,
        )
    ) {
        collectFromBag(bag[1]);
    }

    // Nested optional bags use a property as the bag expression:
    // `args.semanticReviewPort?.getDiffText`. The singular `Port`, `Overrides`, and
    // `Dependencies` spellings used to evade both the name and type checks.
    for (
        const read of scannedText.matchAll(
            new RegExp(
                `\\b(?:[A-Za-z_$][\\w$]*\\.)*([A-Za-z_$][\\w$]*${NESTED_OVERRIDE_PROPERTY_SUFFIX})\\s*\\?\\.\\s*([A-Za-z_$][\\w$]*)`,
                "g",
            ),
        )
    ) {
        names.add(read[2]);
    }

    // Capability fallbacks: `const browser = options.browser || SYSTEM_BROWSER_PORT`.
    //
    // A port property that is optional with a production default is an override bag
    // wearing a port's name: a caller passing nothing silently gets the real thing, and
    // nothing at the call site shows which one ran. The same-name rule above cannot see
    // these because the two sides never share a name — `localCI` falls back to
    // `systemLocalCIPort`, `browser` to `SYSTEM_BROWSER_PORT` — and the names are nouns,
    // so the behavioral-verb test rejects them too. Being nouns is exactly how a whole
    // class of them sat unrecorded.
    //
    // Evidence is deliberately usage-based rather than another list of noun spellings:
    // the fallback counts when the result is *invoked*. `overrides.summary ??
    // DEFAULT_FRONT_MATTER.summary` picks a value out of a constant and never calls it;
    // `options.browser || SYSTEM_BROWSER_PORT` is opened. Reaching into a constant for a
    // field is the other tell, so the implementation has to be handed over whole.
    for (const capability of collectCapabilityFallbacks(scannedText)) names.add(capability);

    // Structural fallback: a behavioral member falling back to a production
    // implementation is replaceable machinery even when the two names differ. This
    // sees both `options._buildAgentSession || buildAgentSession` and
    // `options.runGuideCommand || runConfiguredGuideCommand`; renaming the concrete
    // implementation must not make the seam disappear.
    for (
        const fallback of scannedText.matchAll(
            /((?:options|args|opts|deps|ports|overrides|dependencies)(?:\s*(?:\?\.|\.)\s*[A-Za-z_$][\w$]*)+)\s*(?:\|\||\?\?)\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)/g,
        )
    ) {
        const member = finalMemberName(fallback[1]);
        const implementation = finalMemberName(fallback[2]);
        // A field read can supply data even when the option name is a verb:
        // `options.clearAttachedContext || payload.standaloneReview` is a Boolean
        // condition, not an implementation fallback. Method-shaped members still count.
        if (fallback[2].includes(".") && !isBehavioralCollaborator(implementation)) continue;
        if (substitutesImplementation(member, member, implementation, true)) names.add(member);
    }

    // An inline no-op is still an implementation fallback. It is worse than a named
    // default because the command can report success while silently doing nothing:
    // `options.setActiveModel || (() => {})`. There is no implementation name to
    // compare, so the behavioral member name is the evidence.
    for (
        const fallback of scannedText.matchAll(
            /((?:[A-Za-z_$][\w$]*\s*(?:\?\.|\.)\s*)+[A-Za-z_$][\w$]*)\s*(?:\|\||\?\?)\s*\(\s*\(\s*\)\s*=>\s*\{\s*\}\s*\)/g,
        )
    ) {
        const member = finalMemberName(fallback[1]);
        if (isBehavioralCollaborator(member)) names.add(member);
    }

    // Destructuring defaults hide the same choice in a parameter declaration:
    // `{ recordMetric: recordMetricImpl = recordMetric }` or
    // `{ finalizePlanImplementation = finalizePlanImplementationFn }`.
    //
    // A default written into a parameter list is a seam the caller opts into. The same
    // text inside a `const { … } = deps` statement is an already-required dependency
    // being unpacked, with a convenience default — constructor injection, the shape this
    // check tells people to migrate *to*. Both are scanned; only the former gets the
    // broad different-name rule, and the distinction has to be positional rather than
    // per-pattern or a trailing comma decides it.
    const statementDestructureRanges = [...scannedText.matchAll(/(?:const|let|var)\s*\{/g)].map((match) => {
        const open = (match.index || 0) + match[0].lastIndexOf("{");
        let depth = 0;
        for (let cursor = open; cursor < scannedText.length; cursor++) {
            if (scannedText[cursor] === "{") depth++;
            if (scannedText[cursor] === "}") depth--;
            if (depth === 0) return [open, cursor];
        }
        return [open, scannedText.length];
    });
    /** @param {number} index */
    const allowsBroadRule = (index) =>
        !statementDestructureRanges.some(([open, close]) => index > open && index < close);
    for (
        const fallback of scannedText.matchAll(
            /(?:^|[{,]\s*)([A-Za-z_$][\w$]*)(?:\s*:\s*([A-Za-z_$][\w$]*))?\s*=\s*([A-Za-z_$][\w$]*)(?=\s*[,}])/gm,
        )
    ) {
        const property = fallback[1];
        const local = fallback[2] || property;
        const implementation = fallback[3];
        if (
            substitutesImplementation(property, local, implementation, allowsBroadRule(fallback.index || 0))
        ) names.add(property);
    }

    // Positional parameter defaults are another spelling of the same seam:
    // `getModelRegistry = getModelRegistryFn` and `readTextFile = Deno.readTextFile`.
    //
    // The optional annotation group matters: without it `log: CommandLog = console.log`
    // parsed as the parameter being called `CommandLog`, which is capitalized and so
    // looked behavioral. That reported a *type name* as the injected collaborator —
    // a seam nobody could act on, in a module that had not done anything wrong.
    for (
        const fallback of scannedText.matchAll(
            /\b([A-Za-z_$][\w$]*)\s*(?::[^=,()<>!]*)?(?<![=!<>])=(?!=)\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)\s*(?=[,)])/g,
        )
    ) {
        const local = fallback[1];
        const implementation = finalMemberName(fallback[2]);
        if (substitutesImplementation(local, local, implementation, allowsBroadRule(fallback.index || 0))) {
            names.add(normalizeCollaboratorName(local));
        }
    }

    // A production option explicitly named `__testSomething` is already declaring a
    // test seam even when it is not a bag.
    for (const member of scannedText.matchAll(/\.\s*(__test[A-Za-z_$][\w$]*)\b/g)) {
        if (member[1] !== "__testDeps") names.add(member[1]);
    }

    for (const assigned of collectTestHookAssignments(scannedText)) {
        if (/(?:Deps|Dependencies)$/.test(assigned)) collectFromBag(assigned);
        else names.add(assigned);
    }

    for (const name of collectDeclaredMachinery(text)) names.add(name);

    // Aliased bags: `const deps = __testDeps || {}` and then either `deps.name` or
    // `const { name: nameDep } = deps`.
    //
    // One line of indirection was enough to make a whole bag invisible to this scan,
    // machinery included — which is how `recordPlanEvent` sat behind a seam in
    // plan-written.js under a green ratchet, and how 38 names in load-plan/index.js
    // stayed uncounted behind a rename-on-destructure. A rule that a rename defeats is
    // not a rule.
    //
    // The bag must be the initializer's *value*, not an argument inside it. Requiring a
    // `||`, `??` or `;` right after it separates `const deps = __testDeps || {}` from
    // `const agentDef = await loadSlicerAgentDef(__deps)`, where the result is an agent
    // definition and counting `agentDef.displayName` would invent a seam nothing injects.
    for (
        const alias of scannedText.matchAll(
            /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*[^;\n]*?__(?:test)?[Dd]eps\s*(?:\|\||\?\?|;)/g,
        )
    ) {
        collectFromBag(alias[1]);
    }

    // Bags that arrive as a typed parameter: `function f(deps: LoadPlanTestDeps)`.
    //
    // Splitting a command into modules hands the bag onward as an ordinary
    // argument, and the reads move with it. Counting only `__deps`-named bags let
    // four seams vanish from load-plan/index.js the moment `createPlanSessionSurface`
    // moved to its own file — they were still injected, just out of view. The type
    // name is the tell: a parameter is a dependency bag when it is annotated as one.
    // A file that names a bag has already declared it takes injected dependencies, so
    // any bag-typed parameter in it is that bag being passed along — including the
    // merged, all-required form a `mergeDeps` helper returns. Only files that never
    // mention one need the shape test below to tell an override bag from ordinary
    // constructor injection.
    const declaresBag = /__(?:test)?[Dd]eps/.test(scannedText);
    for (const param of scannedText.matchAll(new RegExp(DEPS_PARAMETER_SOURCE, "g"))) {
        const typeName = param[2];
        const hasLocalDeclaration = new RegExp(`(?:interface|type)\\s+${typeName}\\b`).test(scannedText);
        const requiredImportedSingularPort = typeName.endsWith("Port") && !param[0].includes("?") &&
            !hasLocalDeclaration;
        if (declaresBag || (!requiredImportedSingularPort && isOverrideBagType(scannedText, typeName))) {
            collectFromBag(param[1]);
        }
    }
    return [...names].sort();
}

/**
 * A capability port is required and exposes a real external boundary. `ports = {}`
 * and `ports?.name || realName` are the old optional override-bag pattern under a
 * new name: callers may selectively replace RunWield machinery while production
 * silently falls back to the imported implementation.
 *
 * @param {string} text Comment-free source text.
 * @returns {boolean}
 */
function declaresOptionalFallbackPorts(text) {
    return /\bports\s*=\s*\{\}/.test(text) || /\bports\s*\?\./.test(text);
}

/**
 * Whether `typeName` describes an override bag rather than injected dependencies.
 *
 * Only consulted for files that never name a bag directly. An override bag is
 * entirely optional: every member has a production default the caller may replace,
 * which is the shape a test uses to swap behaviour out from under the code. A type with required members is the opposite — the caller must
 * supply them, so nothing is being silently substituted, and that is exactly the
 * capability-port shape this check tells people to move to. Flagging it would
 * punish the fix.
 *
 * @param {string} text Source of the file declaring the type.
 * @param {string} typeName
 * @returns {boolean}
 */
function isOverrideBagType(text, typeName) {
    const declaration = new RegExp(`(?:interface|type)\\s+${typeName}\\b[^{]*\\{([^}]*)\\}`).exec(text);
    if (!declaration) return true;
    const members = declaration[1]
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("//") && !line.startsWith("*") && !line.startsWith("/*"));
    if (members.length === 0) return false;
    return members.every((member) => /^[A-Za-z_$][\w$]*\s*\?/.test(member));
}

/**
 * Blank out comments so declarations cannot be mistaken for code.
 *
 * JSDoc describes these bags in TypeScript-ish syntax (`__deps?: { … }`), which
 * looks exactly like a ternary to a text scan. Newlines are preserved so reported
 * line numbers still point at the real source line.
 *
 * @param {string} text
 * @returns {string}
 */
function blankComments(text) {
    return text
        .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
        .replace(/(^|[^:])\/\/[^\n]*/g, (line, prefix) => prefix + " ".repeat(line.length - prefix.length));
}

/**
 * Walk back from a ternary's `?` to where its condition begins.
 *
 * Matching the condition by adjacency — "a `__deps` read immediately before the `?`" —
 * only catches the shapes we happened to have seen. It missed
 * `((__deps?.a && __deps?.b) ? fake : real)`, where the read is two tokens and a paren
 * away from the `?`, which is how a live conditional seam sat in `workflow.js` under a
 * green ratchet. So delimit the whole condition instead and look inside it.
 *
 * Scans backwards keeping bracket depth, stopping at the first delimiter that cannot
 * appear inside a condition: an unbalanced opener, a statement or argument separator, an
 * assignment or arrow, or the `?`/`:` of an enclosing ternary. Comparison operators
 * (`===`, `!==`, `<=`, `>=`) are stepped over rather than treated as assignments, so a
 * branch on an injected *value* is still seen in full.
 *
 * @param {string} text
 * @param {number} index Position of the `?`.
 * @returns {number} Start index of the condition expression.
 */
function findConditionStart(text, index) {
    let depth = 0;
    for (let cursor = index - 1; cursor >= 0; cursor--) {
        const char = text[cursor];
        if (char === ")" || char === "]" || char === "}") {
            depth++;
            continue;
        }
        if (char === "(" || char === "[" || char === "{") {
            if (depth === 0) return cursor + 1;
            depth--;
            continue;
        }
        if (depth > 0) continue;
        if (char === "?") {
            // `?.` and `??` sit *inside* a condition — treating them as the `?` of an
            // enclosing ternary would cut `__deps?.a ? fake : real` off at the optional
            // chain and hide the read we are looking for.
            if (text[cursor + 1] === "." || text[cursor + 1] === "?" || text[cursor - 1] === "?") continue;
            return cursor + 1;
        }
        if (char === ";" || char === "," || char === ":") return cursor + 1;
        if (char === "=") {
            const isComparison = text[cursor + 1] === "=" || "=!<>".includes(text[cursor - 1] || "");
            if (!isComparison) return cursor + 1;
        }
    }
    return 0;
}

/** @param {string} expression @param {Set<string>} bagNames */
function containsOverrideBagReference(expression, bagNames) {
    if (/__(?:test)?[Dd]eps/.test(expression) || /\.__test[A-Za-z_$][\w$]*/.test(expression)) return true;
    if (new RegExp(`\\b[A-Za-z_$][\\w$]*${NESTED_OVERRIDE_PROPERTY_SUFFIX}\\s*\\?\\.`).test(expression)) return true;
    return [...bagNames].some((name) => new RegExp(`\\b${name}\\b`).test(expression));
}

/**
 * A stable fingerprint for one conditional seam.
 *
 * Source lines are useful in diagnostics but unstable in a ratchet. The behavior
 * being replaced is the durable identity: `deps.now ? … : …` is `members:now`, and
 * a condition involving two override members records both. A direct branch on the
 * whole bag is recorded as `bags:__deps`.
 *
 * @param {string} condition
 * @param {Set<string>} bagNames
 */
function conditionalSeamKey(condition, bagNames) {
    const members = new Set();
    const bags = new Set();
    for (
        const read of condition.matchAll(
            /\b(__testDeps|__deps|__Deps)\s*(?:\?\.|\.)\s*([A-Za-z_$][\w$]*)/g,
        )
    ) {
        members.add(read[2]);
    }
    for (const read of condition.matchAll(/\.\s*(__test[A-Za-z_$][\w$]*)\b/g)) members.add(read[1]);
    for (
        const read of condition.matchAll(
            new RegExp(
                `\\b[A-Za-z_$][\\w$]*${NESTED_OVERRIDE_PROPERTY_SUFFIX}\\s*\\?\\.\\s*([A-Za-z_$][\\w$]*)`,
                "g",
            ),
        )
    ) {
        members.add(read[1]);
    }
    for (const name of bagNames) {
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        for (
            const read of condition.matchAll(
                new RegExp(`\\b${escaped}\\s*(?:\\?\\.|\\.)\\s*([A-Za-z_$][\\w$]*)`, "g"),
            )
        ) {
            members.add(read[1]);
        }
        if (new RegExp(`\\b${escaped}\\s*(?![.?\\w])`).test(condition)) bags.add(name);
    }
    for (const bag of condition.matchAll(/\b(__testDeps|__deps|__Deps)\s*(?![.?\w])/g)) bags.add(bag[1]);
    const parts = [];
    if (bags.size > 0) parts.push(`bags:${[...bags].sort().join("+")}`);
    if (members.size > 0) parts.push(`members:${[...members].sort().join("+")}`);
    return parts.join("|");
}

/** @typedef {{ offender: string, key: string }} ConditionalSeamHit */

/**
 * @param {string} text
 * @returns {ConditionalSeamHit[]}
 */
function scanConditionalSeams(text) {
    /** @type {ConditionalSeamHit[]} */
    const hits = [];
    const scanned = blankComments(text);
    const bagNames = new Set();
    for (const bag of scanned.matchAll(/\b(deps|dependencies)\s*=\s*\{\}/gi)) bagNames.add(bag[1]);
    for (
        const bag of scanned.matchAll(
            /(?:let|var)\s+([A-Za-z_$][\w$]*(?:Deps|Dependencies))\s*=\s*[A-Za-z_$][\w$]*(?:Deps|Dependencies)\b/g,
        )
    ) bagNames.add(bag[1]);
    for (let index = 0; index < scanned.length; index++) {
        if (scanned[index] !== "?") continue;
        // Not a ternary: optional chaining (`__deps?.name`), nullish coalescing, and
        // TypeScript's optional parameter and property syntax (`__deps?: { … }`).
        if (".?:".includes(scanned[index + 1] || "")) continue;
        if (scanned[index - 1] === "?") continue;
        const condition = scanned.slice(findConditionStart(scanned, index), index);
        if (!containsOverrideBagReference(condition, bagNames)) continue;
        const line = text.slice(0, index).split("\n").length;
        const gatedOnBag = /__(?:test)?[Dd]eps\s*(?![.?\w])/.test(condition) ||
            [...bagNames].some((name) => new RegExp(`\\b${name}\\s*(?![.?\\w])`).test(condition));
        hits.push({
            offender: `line ${line} (${gatedOnBag ? "gated on the bag itself" : "one seam gated on another dep"})`,
            key: conditionalSeamKey(condition, bagNames),
        });
    }
    return hits;
}

/**
 * Seams whose value depends on whether anything at all was injected.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function collectConditionalSeams(text) {
    return scanConditionalSeams(text).map((hit) => hit.offender);
}

/**
 * Stable conditional seam identities for the shrink-only baseline. Duplicates are
 * intentional: two branches on `deps.now` are two seams, and removing either one
 * should tighten the ratchet.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function collectConditionalSeamKeys(text) {
    return scanConditionalSeams(text).map((hit) => hit.key).sort();
}

/**
 * @param {ReadonlyArray<{ rootUrl: URL, pathPrefix: string }>} [roots]
 */
export async function collectSeams(roots = PRODUCTION_ROOTS) {
    /** @type {SeamEntry} */
    const seams = {};
    const ciFiles = roots === PRODUCTION_ROOTS ? new Set(await listCiFiles(REPO_ROOT)) : null;

    /** @param {URL} directoryUrl @param {string} relativeDirectory @param {string} pathPrefix */
    async function walk(directoryUrl, relativeDirectory, pathPrefix) {
        for await (const entry of await fsReaddir(directoryUrl, { withFileTypes: true })) {
            const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
            if (entry.isDirectory()) {
                if (SKIP_DIRS.has(entry.name)) continue;
                await walk(new URL(`${entry.name}/`, directoryUrl), relativePath, pathPrefix);
                continue;
            }
            if (!isProductionSourcePath(relativePath)) continue;
            const productionPath = `${pathPrefix}/${relativePath}`;
            if (ciFiles && !ciFiles.has(productionPath)) continue;
            if (SCAN_EXCLUDED_PATHS.has(productionPath)) continue;
            const text = await fsReadFile(new URL(entry.name, directoryUrl), "utf8");
            // Scan every production source file. A known-spelling prefilter made the
            // detector self-defeating: files using `dependencies`, nested ports,
            // ordinary options, or individual test hooks never reached the structural
            // checks intended to catch them.
            const names = collectSeamNames(text);
            const conditional = collectConditionalSeamKeys(text);
            if (names.length === 0 && conditional.length === 0) continue;
            seams[productionPath] = {
                seams: names,
                machinery: names.filter(isMachinerySeam),
                conditional,
            };
        }
    }

    for (const { rootUrl, pathPrefix } of roots) await walk(rootUrl, "", pathPrefix);
    return seams;
}

/** @param {string[]} entries */
function formatList(entries) {
    return entries.map((entry) => `  - ${entry}`).join("\n");
}

/** @typedef {Record<string, { seams: string[], machinery: string[], conditional?: string[] }>} SeamEntry */

/**
 * Values present more times in `current` than in `baseline`.
 *
 * @param {string[]} current
 * @param {string[]} baseline
 */
function multisetAdditions(current, baseline) {
    const remaining = [...baseline];
    return current.filter((value) => {
        const index = remaining.indexOf(value);
        if (index < 0) return true;
        remaining.splice(index, 1);
        return false;
    });
}

async function readBaseline() {
    const parsed = JSON.parse(await fsReadFile(BASELINE_PATH, "utf8"));
    if (!parsed || typeof parsed.files !== "object") {
        throw new Error(
            "injection-seam-baseline.json must contain a { files: { path: { seams, machinery, conditional } } } object",
        );
    }
    return /** @type {SeamEntry} */ (parsed.files);
}

/**
 * @param {SeamEntry} current
 * @param {SeamEntry} baseline
 * @param {boolean} [adoptNewlyVisible] Record modules or individual seams the scan can
 *   now see for the first time. Only ever correct together with a detection fix: the
 *   seams were always there, and once recorded they can only shrink like every other
 *   entry.
 */
export function findRegressions(current, baseline, adoptNewlyVisible = false) {
    /** @type {string[]} */
    const problems = [];
    for (const [path, entry] of Object.entries(current)) {
        const before = baseline[path];
        if (!before) {
            if (!adoptNewlyVisible) {
                const conditional = entry.conditional?.length || 0;
                problems.push(
                    `${path}: newly detected module with ${entry.seams.length} injection seam(s)` +
                        `${conditional > 0 ? ` and ${conditional} conditional seam(s)` : ""}` +
                        `${entry.seams.length > 0 ? ` (${entry.seams.join(", ")})` : ""}. ` +
                        "Pass capability ports as required arguments instead of an override bag.",
                );
            }
            continue;
        }
        // Compared by name, not by count: swapping one seam for another keeps the count
        // flat while quietly changing what the module claims it does not own.
        const added = entry.seams.filter((name) => !before.seams.includes(name));
        if (added.length > 0 && !adoptNewlyVisible) {
            problems.push(`${path}: new injection seam(s): ${added.join(", ")}.`);
        }
        const addedConditional = multisetAdditions(entry.conditional || [], before.conditional || []);
        if (addedConditional.length > 0 && !adoptNewlyVisible) {
            problems.push(`${path}: new conditional injection seam(s): ${addedConditional.join(", ")}.`);
        }
        // Only a *new* seam over machinery is a regression. When the denylist grows to
        // recognize a seam that already existed, the code did not get worse — our
        // understanding did, and refusing that would mean never being allowed to admit
        // a mistake. Those are recorded by `--update` so they can still only shrink.
        const addedMachinery = entry.machinery
            .filter((name) => !before.machinery.includes(name))
            .filter((name) => !before.seams.includes(name));
        if (addedMachinery.length > 0 && !adoptNewlyVisible) {
            problems.push(
                `${path}: machinery must never be replaceable, but these became injectable: ${
                    addedMachinery.join(", ")
                }.`,
            );
        }
    }
    return problems;
}

/**
 * @param {SeamEntry} current
 * @param {SeamEntry} baseline
 */
function findStaleBaseline(current, baseline) {
    /** @type {string[]} */
    const stale = [];
    for (const [path, before] of Object.entries(baseline)) {
        const entry = current[path];
        if (!entry) {
            stale.push(`${path}: no seams left — remove it from the baseline to lock the win in.`);
            continue;
        }
        const removed = before.seams.filter((name) => !entry.seams.includes(name));
        if (removed.length > 0) {
            stale.push(`${path}: seam(s) removed (${removed.join(", ")}) — tighten the baseline.`);
        }
        const removedConditional = multisetAdditions(before.conditional || [], entry.conditional || []);
        if (removedConditional.length > 0) {
            stale.push(
                `${path}: conditional seam(s) removed (${removedConditional.join(", ")}) — tighten the baseline.`,
            );
        }
        const reclassified = entry.machinery.filter((name) => !before.machinery.includes(name));
        if (reclassified.length > 0) {
            stale.push(
                `${path}: existing seam(s) now recognized as machinery (${
                    reclassified.join(", ")
                }) — record them so they can only shrink.`,
            );
        }
    }
    return stale;
}

/**
 * @param {SeamEntry} baseline
 * @param {Array<[string, string]>} renames
 * @returns {SeamEntry}
 */
function applyRenames(baseline, renames) {
    if (renames.length === 0) return baseline;
    const map = new Map(renames);
    /** @type {SeamEntry} */
    const renamed = {};
    for (const [path, entry] of Object.entries(baseline)) {
        renamed[path] = {
            seams: [...new Set(entry.seams.map((name) => map.get(name) || name))].sort(),
            machinery: [...new Set(entry.machinery.map((name) => map.get(name) || name))].sort(),
            conditional: (entry.conditional || []).map((key) =>
                key.replace(/[A-Za-z_$][\w$]*/g, (name) => map.get(name) || name)
            ).sort(),
        };
    }
    return renamed;
}

/**
 * Relocate seams between modules in the baseline before comparing.
 *
 * Splitting a file does not add or remove a seam, but a per-module comparison
 * cannot see that: the seam simply vanishes from one entry and appears in
 * another. This carries it across, and refuses anything that would invent one —
 * the seam must already be recorded against the source.
 *
 * @param {SeamEntry} baseline
 * @param {Array<[string, string, string]>} moves `[fromPath, name, toPath]`
 * @returns {SeamEntry}
 */
function applyMoves(baseline, moves) {
    if (moves.length === 0) return baseline;
    /** @type {SeamEntry} */
    const moved = {};
    for (const [path, entry] of Object.entries(baseline)) {
        moved[path] = {
            seams: [...entry.seams],
            machinery: [...entry.machinery],
            conditional: [...(entry.conditional || [])],
        };
    }
    for (const [fromPath, name, toPath] of moves) {
        const source = moved[fromPath];
        if (!source || !source.seams.includes(name)) {
            console.error(`--move cannot carry "${name}": it is not recorded against ${fromPath}.`);
            process.exit(1);
        }
        source.seams = source.seams.filter((seam) => seam !== name);
        source.machinery = source.machinery.filter((seam) => seam !== name);
        if (source.seams.length === 0 && (source.conditional?.length || 0) === 0) delete moved[fromPath];
        const target = moved[toPath] || { seams: [], machinery: [], conditional: [] };
        target.seams = [...new Set([...target.seams, name])].sort();
        if (isMachinerySeam(name)) target.machinery = [...new Set([...target.machinery, name])].sort();
        moved[toPath] = target;
    }
    return moved;
}

if (import.meta.main) {
    const update = process.argv.slice(2).includes("--update");
    // Only meaningful alongside a fix to the scan itself: it adopts modules and seams
    // the scan could not previously see. The resulting baseline remains shrink-only.
    const adopt = process.argv.slice(2).includes("--adopt-newly-visible");
    /** @type {Array<[string, string, string]>} */
    const moves = [];
    for (let index = 0; index < process.argv.slice(2).length; index++) {
        if (process.argv.slice(2)[index] !== "--move") continue;
        const spec = process.argv.slice(2)[index + 1] || "";
        const [source, toPath] = spec.split("=");
        const separator = source.lastIndexOf(":");
        if (!toPath || separator < 1) {
            console.error(`--move expects fromPath:name=toPath, received "${spec}".`);
            process.exit(1);
        }
        moves.push([source.slice(0, separator), source.slice(separator + 1), toPath]);
    }
    /** @type {Array<[string, string]>} */
    const renames = [];
    for (let index = 0; index < process.argv.slice(2).length; index++) {
        if (process.argv.slice(2)[index] !== "--rename") continue;
        const pair = process.argv.slice(2)[index + 1] || "";
        const [from, to] = pair.split("=");
        if (!from || !to) {
            console.error(`--rename expects old=new, received "${pair}".`);
            process.exit(1);
        }
        renames.push([from, to]);
    }
    const seams = await collectSeams();
    const sortedSeams = Object.fromEntries(Object.entries(seams).sort(([a], [b]) => a.localeCompare(b)));

    if (update) {
        const baseline = applyMoves(applyRenames(await readBaseline().catch(() => ({})), renames), moves);
        const regressions = findRegressions(sortedSeams, baseline, adopt);
        if (Object.keys(baseline).length > 0 && regressions.length > 0) {
            console.error(
                `Refusing to loosen the injection-seam baseline:\n${formatList(regressions)}\n\n` +
                    "`--update` records progress; it is not a way to admit a new seam. Reshaping the seam so the\n" +
                    "scan stops seeing it — a rename, an alias, a helper, a retyped `Port`, a hand-edited baseline —\n" +
                    "is the same thing with extra steps: the module can still have its behaviour replaced. Remove\n" +
                    "the seam instead. Inject only true ports (Git, filesystem, clock, network) as required\n" +
                    "arguments with no production fallback; import everything of ours directly.",
            );
            process.exit(1);
        }
        await fsWriteFile(
            BASELINE_PATH,
            `${
                JSON.stringify(
                    {
                        comment:
                            "Injection-seam ratchet. Seam, machinery, and conditional lists may only shrink. See docs/plans/finish-injection-seam-ownership-enforcement.md.",
                        files: sortedSeams,
                    },
                    null,
                    4,
                )
            }\n`,
        );
        console.log("Updated scripts/injection-seam-baseline.json.");
        process.exit(0);
    }

    const baseline = applyMoves(applyRenames(await readBaseline(), renames), moves);
    const regressions = findRegressions(sortedSeams, baseline);
    const stale = findStaleBaseline(sortedSeams, baseline);

    if (regressions.length > 0 || stale.length > 0) {
        const sections = [];
        if (regressions.length > 0) {
            sections.push(`Injection-seam regressions:\n${formatList(regressions)}`);
        }
        if (stale.length > 0) {
            sections.push(
                `Seams were removed — run \`bun run seams:update\` to lock the progress in:\n${formatList(stale)}`,
            );
        }
        sections.push(
            "Why this is enforced: a seam is a public claim that something is not ours. RunWield's own\n" +
                "machinery (Plan writes, lifecycle transitions, registry writes, locks) must never be replaceable,\n" +
                "because a guarantee that only exists when components compose cannot be tested with the composing\n" +
                "part removed. Fake the environment instead — `defineGitFixture` gives a real Git repo in ~5ms and\n" +
                "`makeValidationProjectRoot` a real Plan project.\n\n" +
                "If you ADDED a seam: remove it and pass a capability port as a required argument instead.\n" +
                "If you ADDED a conditional seam: remove the branch; existing conditional debt may only shrink.\n" +
                "If you REMOVED seams: run `bun run seams:update` to tighten the baseline in the same change.\n" +
                "Never run `--update` to silence an addition; it refuses to loosen and will reject it.\n" +
                "Background: docs/plans/finish-injection-seam-ownership-enforcement.md and src/skills/write-tests/SKILL.md.",
        );
        sections.push(
            "If you are an agent: do not make this pass by changing how the seam LOOKS.\n" +
                "Renaming the bag, aliasing it through a local, spelling the fallback a different way, hiding the\n" +
                "read behind a helper or a computed key, retyping an optional bag as a `Port`, or widening a skip\n" +
                "list in this script all leave the seam exactly where it was — they only cost the next reader the\n" +
                "ability to see it. Every rule above exists because that was tried and the detector was blind to it\n" +
                "for a while; a rule a rename defeats is not a rule, and a detector you defeat still leaves the\n" +
                "design defect you were asked to fix. This check is a proxy for the design rule, not the rule.\n" +
                "The only passing change is one where the module can no longer have its behaviour replaced.\n" +
                "Use injection ONLY for a true port: a genuine boundary to something outside RunWield (Git, the\n" +
                "filesystem, the clock, a network service), typed with required members and passed as a required\n" +
                "argument, with no production fallback. Everything else is ours — import it and call it directly,\n" +
                "and test it against a real fixture environment. Editing this script or hand-editing the baseline\n" +
                "to accommodate a new seam is the same circumvention by another route.",
        );
        sections.push(
            "Equally: do not over-correct. The baseline is a ratchet, not a refactor queue — nothing here asks\n" +
                "you to go remove seams you did not introduce, and a module already in the baseline is allowed to\n" +
                "stay exactly as it is. Parameter defaults are matched by a deliberately broad heuristic (a\n" +
                "behavioural-looking name defaulting to any implementation), so it will occasionally name\n" +
                "something that is really a data default or a genuine required port. If that happens, say so and\n" +
                "leave the code alone — a false positive is a reason to narrow the heuristic here, with a test\n" +
                "pinning the case, not a reason to restructure a module that was already right. Changing working\n" +
                "code to satisfy a check that misread it is its own kind of damage.",
        );
        console.error(sections.join("\n\n"));
        process.exit(1);
    }

    const total = Object.values(sortedSeams).reduce((sum, entry) => sum + entry.seams.length, 0);
    const machinery = Object.values(sortedSeams).reduce((sum, entry) => sum + entry.machinery.length, 0);
    const conditional = Object.values(sortedSeams).reduce(
        (sum, entry) => sum + (entry.conditional?.length || 0),
        0,
    );
    console.log(
        `Injection-seam baseline holds: ${total} seam(s) across ${
            Object.keys(sortedSeams).length
        } module(s), ${machinery} of them machinery and ${conditional} conditional seam(s) still to remove.`,
    );
}
