import { RunWieldTui } from "./tui.ts";
import { getCwd } from "../../constants.js";
import { getSettingsManager, isMascotEnabled } from "../../shared/settings.js";
import type { SessionRuntime } from "../../shared/session/session-runtime.ts";
import {
    CombinedAutocompleteProvider,
    Container,
    Editor,
    HStack,
    Image,
    isViewportTUI,
    ScrollView,
    Spacer,
    Text,
    truncateToWidth,
    TUI,
    visibleWidth,
    VStack,
} from "@earendil-works/pi-tui";
import {
    applyPersistedTheme,
    getEditorTheme,
    imageTheme,
    initRunWieldTheme,
    onThemeChange,
    theme,
} from "../theme/theme.js";
import { VERSION } from "../../shared/version.js";
import {
    getCachedUpdateAvailabilitySync,
    refreshUpdateCheckCache,
    SYSTEM_UPDATE_CHECK_PORTS,
} from "../../shared/update-check.js";
import { endBlink, renderBootLogo } from "./boot-logo.ts";
import { createUiApi } from "./api.js";
import { SpinnerBlock, ToolExecutionBlock, ToolExecutionGroupBlock } from "./blocks.js";
import { createSessionSnapshotWindow } from "./session-snapshot-window.ts";
import { type FooterTheme, renderUpdateNoticeLine } from "./chat-footer.ts";
import { installUiApiOverrides } from "./ui-api-overrides.ts";
import { hasClipboardImage } from "./clipboard.ts";
import type { Component } from "@earendil-works/pi-tui";
import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import type { ImageAttachment } from "../../shared/session/types.js";
import type { WorkflowPresentationAction } from "../../shared/workflow/workflow-presentation.ts";
import type { UiAPI } from "./types.js";
import {
    composePinnedSessionSidebar,
    isSessionArtifactOpenKey,
    isSessionSidebarActionKey,
    isSessionSidebarCycleKey,
    TuiSessionSidebar,
    type TuiSessionSidebarSnapshot,
} from "./session-sidebar.ts";
import { readSessionArtifact } from "../../shared/session/read-session-artifact.ts";
import { SYSTEM_BROWSER_PORT } from "../../shared/browser-port.ts";
import { startArtifactReadSurface } from "../review/review-launcher.ts";

import { TuiAgentMascot } from "./agent-mascot.ts";
import { mascotPose } from "../mascot/mascot.ts";

const SESSION_SIDEBAR_MIN_WIDTH = 132;
const MASCOT_RAIL_MIN_WIDTH = 80;

export interface ChatViewSessionSnapshot extends TuiSessionSidebarSnapshot {
    activeAgentInfo?: { agentName?: string } | null;
    cwd: string;
    activeModel: { model?: string | null; provider?: string | null };
}

import type { DocumentLinkHost } from "../review/document-link-host.ts";

interface ChatViewSharedOptions {
    documentLinks: DocumentLinkHost | null;
    tui: TUI;
    getSessionId(): string;
    suppressStartupHeader: boolean;
    setActiveModel(model: string, provider?: string): Promise<{ status: "active" | "deferred"; message?: string }>;
    configureUiAPI?: (uiAPI: UiAPI) => void;
    onWorkflowAction?: (action: WorkflowPresentationAction, snapshot: ChatViewSessionSnapshot) => void | Promise<void>;
}
interface ChatSessionViewOptions extends ChatViewSharedOptions {
    sessionRuntime: SessionRuntime;
}

/** Login has no Session or Session store; model setup reads project settings. */
interface ChatSetupViewOptions extends ChatViewSharedOptions {
    sessionRuntime: null;
    projectRoot: string;
}

export type ChatViewOptions = ChatSessionViewOptions | ChatSetupViewOptions;

interface RenderedChildLayout {
    component: Component;
    height: number;
}

interface RenderedChildContent {
    width: number;
    lines: string[];
}

interface RenderedContainerContent {
    width: number;
    lines: string[];
    children: RenderedChildLayout[];
}

type VisibleToolBlock = ToolExecutionGroupBlock | ToolExecutionBlock;

class MeasuredContainer extends Container {
    renderedChildren: RenderedChildLayout[] = [];
    private readonly renderedLinesByChild = new Map<Component, RenderedChildContent>();
    private renderedContent: RenderedContainerContent | undefined;

    constructor(
        private readonly parent?: MeasuredContainer,
        private readonly cacheAllChildren = true,
    ) {
        super();
    }

    invalidateChild(child: Component): void {
        this.renderedLinesByChild.delete(child);
        this.renderedContent = undefined;
        this.parent?.invalidateChild(this);
    }

    override invalidate(): void {
        this.renderedLinesByChild.clear();
        this.renderedContent = undefined;
        super.invalidate();
    }

    override addChild(child: Component): void {
        super.addChild(child);
        this.renderedContent = undefined;
        this.parent?.invalidateChild(this);
    }

    override removeChild(child: Component): void {
        this.renderedLinesByChild.delete(child);
        this.renderedContent = undefined;
        super.removeChild(child);
        this.parent?.invalidateChild(this);
    }

    override clear(): void {
        this.renderedLinesByChild.clear();
        this.renderedContent = undefined;
        super.clear();
        this.parent?.invalidateChild(this);
    }

    override render(width: number): string[] {
        const cachedContent = this.cacheAllChildren && this.renderedContent?.width === width
            ? this.renderedContent
            : undefined;
        if (cachedContent) {
            this.renderedChildren = cachedContent.children;
            Reflect.set(this, "mouseLayout", { width, children: this.renderedChildren });
            return cachedContent.lines;
        }
        const lines: string[] = [];
        this.renderedChildren = [];
        for (const child of this.children) {
            const cacheChild = this.cacheAllChildren || child instanceof MeasuredContainer;
            let childLines: string[] | undefined;
            if (cacheChild) {
                const cachedChild = this.renderedLinesByChild.get(child);
                childLines = cachedChild?.width === width ? cachedChild.lines : undefined;
                if (!childLines) {
                    childLines = child.render(width);
                    this.renderedLinesByChild.set(child, { width, lines: childLines });
                }
            } else {
                childLines = child.render(width);
            }
            this.renderedChildren.push({ component: child, height: childLines.length });
            lines.push(...childLines);
        }
        Reflect.set(this, "mouseLayout", { width, children: this.renderedChildren });
        if (this.cacheAllChildren) {
            this.renderedContent = { width, lines, children: this.renderedChildren };
        }
        return lines;
    }
}

export interface ChatView {
    uiAPI: UiAPI;
    tui: TUI;
    editor: Editor;
    container: Container;
    footerContainer: Container;
    messageList: Container;
    validationPanelContainer: Container;
    runningTasksComponent: SpinnerBlock;
    activeInteractionContainer: Container;
    inputAccessoryContainer: Container;
    previewImages: Container;
    pastedImages: ImageAttachment[];
    installAutocompleteProvider(provider: CombinedAutocompleteProvider): void;
    addPastedImagePreview(image: ImageAttachment): void;
    clearPastedImages(): void;
    resetForSessionReplacement(): void;
    focusEditor(): void;
    requestRender(): void;
    dispose(): void;
}

const CLIPBOARD_IMAGE_HINT_TEXT = "Image in clipboard · ctrl+v to paste";

export function findVisibleToolBlocks(
    containerLayout: RenderedChildLayout[],
    messageList: Component,
    messageLayout: RenderedChildLayout[],
    scrollTop: number,
    viewportHeight: number,
): VisibleToolBlock[] {
    if (viewportHeight <= 0) return [];

    let messageTop = 0;
    let foundMessageList = false;
    for (const child of containerLayout) {
        if (child.component === messageList) {
            foundMessageList = true;
            break;
        }
        messageTop += child.height;
    }
    if (!foundMessageList) return [];

    const viewportBottom = scrollTop + viewportHeight;
    let childTop = messageTop;
    const visibleBlocks: VisibleToolBlock[] = [];
    for (const child of messageLayout) {
        const childBottom = childTop + child.height;
        if (
            childBottom > scrollTop && childTop < viewportBottom &&
            (child.component instanceof ToolExecutionGroupBlock || child.component instanceof ToolExecutionBlock)
        ) {
            visibleBlocks.push(child.component);
        }
        childTop = childBottom;
    }
    return visibleBlocks;
}

export function renderClipboardImageHintLines(
    clipboardImageAvailable: boolean,
    pastedImageCount: number,
    width: number,
    themeImpl: FooterTheme = theme,
): string[] {
    if (!clipboardImageAvailable || pastedImageCount > 0 || width <= 0) return [];
    const text = truncateToWidth(CLIPBOARD_IMAGE_HINT_TEXT, width);
    const padding = " ".repeat(Math.max(0, width - visibleWidth(text)));
    return [padding + themeImpl.fg("dim" as ThemeColor, text)];
}

export function createPastedImagePreview(image: ImageAttachment): Image {
    return new Image(image.base64, image.mimeType, imageTheme, {
        filename: image.ref || image.path || image.mimeType,
        maxWidthCells: 30,
        maxHeightCells: 10,
    });
}

export function createChatView(options: ChatViewOptions): Promise<ChatView> {
    return createChatViewInternal(options);
}

async function createChatViewInternal(options: ChatViewOptions): Promise<ChatView> {
    initRunWieldTheme();
    await applyPersistedTheme();
    const tui = options.tui;
    const container = new MeasuredContainer(undefined, false);
    if (!options.suppressStartupHeader) {
        const titleLine = `${theme.fg("accent", theme.bold("RunWield ─ Plan-by-Default Harness"))} ${
            theme.fg("dim", `${VERSION}`)
        }`;
        const compactHelp = theme.fg(
            "muted",
            ["? help", "esc interrupt", "ctrl+c clear/exit", "/ commands", "! bash", "ctrl+o tool groups"].join(" · "),
        );
        const helpText = new Text(compactHelp, 0, 0);
        const updateNoticeText = new Text("", 0, 0);
        const cachedUpdateAvailability = getCachedUpdateAvailabilitySync(SYSTEM_UPDATE_CHECK_PORTS.clock, {
            currentVersion: VERSION,
        });
        if (cachedUpdateAvailability) {
            if (cachedUpdateAvailability.available) {
                updateNoticeText.setText(renderUpdateNoticeLine(cachedUpdateAvailability.latestVersion));
            }
        } else {
            void refreshUpdateCheckCache({ currentVersion: VERSION }, SYSTEM_UPDATE_CHECK_PORTS).then(
                (availability) => {
                    updateNoticeText.setText(
                        availability.available ? renderUpdateNoticeLine(availability.latestVersion) : "",
                    );
                    tui.requestRender();
                },
            ).catch(() => {});
        }
        renderBootLogo(container);
        container.addChild(new Text(titleLine, 0, 0));
        container.addChild(updateNoticeText);
        container.addChild(helpText);
        container.addChild(new Spacer(1));
        container.addChild(new Spacer(1));
        container.addChild(new Spacer(1));
    }
    const messageList = new MeasuredContainer(container);
    container.addChild(messageList);
    container.addChild(new Spacer(1));
    const validationPanelContainer = new Container();
    container.addChild(validationPanelContainer);
    const runningTasksComponent = new SpinnerBlock();
    container.addChild(runningTasksComponent);
    const activeInteractionContainer = new Container();
    container.addChild(activeInteractionContainer);
    const composerContainer = new Container();
    const inputAccessoryContainer = new Container();
    composerContainer.addChild(inputAccessoryContainer);
    const queuedInputContainer = new Container();
    composerContainer.addChild(queuedInputContainer);
    const pastedImages: ImageAttachment[] = [];
    let clipboardImageAvailable = false;
    const previewImages = new Container();
    composerContainer.addChild(previewImages);
    const clipboardImageHint: Component = {
        invalidate: () => {},
        render: (w: number) => renderClipboardImageHintLines(clipboardImageAvailable, pastedImages.length, w),
    };
    composerContainer.addChild(clipboardImageHint);
    const editor = new Editor(tui, getEditorTheme());
    composerContainer.addChild(editor);
    const footerContainer = new Container();
    const mascot = new TuiAgentMascot(() => tui.requestRender());
    let mascotAnswering = false;
    const renderMascot = (width: number, compact: boolean) => {
        const snapshot = options.sessionRuntime?.getSessionSnapshot(options.getSessionId());
        if (!isMascotEnabled(snapshot?.cwd || getCwd())) {
            mascot.pause();
            return [];
        }
        return mascot.render(width, compact, {
            agentName: snapshot?.activeAgentInfo?.agentName || snapshot?.activeAgent || "",
            parentAgentName: snapshot?.activeAgent || undefined,
            sessionId: options.getSessionId(),
            pose: mascotPose({ busy: runningTasksComponent.isBusy, answering: mascotAnswering }),
        });
    };
    let liveValidationProgress: TuiSessionSidebarSnapshot["validationProgress"] = null;
    const sessionSidebar = new TuiSessionSidebar(
        options.getSessionId,
        () => options.sessionRuntime?.getSessionSnapshot(options.getSessionId()) ?? null,
    );
    const snapshotWindow = options.sessionRuntime
        ? createSessionSnapshotWindow(options.sessionRuntime, options.getSessionId)
        : null;
    const bottomDock: Component = {
        invalidate: () => {
            composerContainer.invalidate();
            footerContainer.invalidate();
        },
        render: (w: number) => {
            const availableWidth = Math.max(10, w - 2);
            return [
                ...(w < MASCOT_RAIL_MIN_WIDTH ? renderMascot(availableWidth, true) : []),
                ...composerContainer.render(availableWidth),
                ...footerContainer.render(availableWidth),
            ];
        },
    };
    const transcriptArea: Component = {
        invalidate: () => {
            container.invalidate();
            sessionSidebar.invalidate();
        },
        render: (w: number) => {
            const availableWidth = Math.max(10, w - 2);
            const snapshot = snapshotWindow?.read();
            if (w < MASCOT_RAIL_MIN_WIDTH) return container.render(availableWidth);
            const showSidebar = snapshot?.managed && availableWidth >= SESSION_SIDEBAR_MIN_WIDTH;
            const sidebarWidth = showSidebar ? 34 : 22;
            const mainWidth = Math.max(1, availableWidth - sidebarWidth - 1);
            const mainLines = container.render(mainWidth);
            const dock = bottomDock.render(w);
            const bodyHeight = Math.max(1, tui.terminal.rows - dock.length);
            const mascotLines = renderMascot(sidebarWidth, bodyHeight < 24);
            const sidebarLines = showSidebar
                ? sessionSidebar.render(sidebarWidth, { ...snapshot, validationProgress: liveValidationProgress })
                : [];
            const space = Math.max(0, bodyHeight - mascotLines.length);
            const rail = sidebarLines.slice(0, space);
            while (rail.length < space) rail.push("");
            rail.push(...mascotLines);
            return composePinnedSessionSidebar(mainLines, rail, mainWidth, bodyHeight);
        },
    };
    const rootWrapper: Component = {
        invalidate: () => {
            transcriptArea.invalidate();
            bottomDock.invalidate();
        },
        render: (w: number) => [...transcriptArea.render(w), ...bottomDock.render(w)],
    };
    let transcriptScrollView: ScrollView | undefined;
    if (isViewportTUI(tui)) {
        const scrollbarSafeTranscript: Component = {
            invalidate: () => container.invalidate(),
            render: (width: number) => container.render(Math.max(1, width - 1)),
        };
        transcriptScrollView = new ScrollView(scrollbarSafeTranscript, {
            follow: "end",
            primary: true,
            scrollbar: "auto",
        });
        const sidebarArea: Component = {
            invalidate: () => sessionSidebar.invalidate(),
            render: (width: number) => {
                const snapshot = snapshotWindow?.read();
                return snapshot?.managed
                    ? sessionSidebar.render(width, { ...snapshot, validationProgress: liveValidationProgress })
                    : [];
            },
        };
        const mascotArea: Component = {
            invalidate: () => {},
            render: (width: number) =>
                renderMascot(width, tui.terminal.rows - bottomDock.render(tui.terminal.columns).length < 24),
        };
        const rail = new VStack([
            { component: new ScrollView(sidebarArea, { scrollbar: "auto" }), basis: 0, grow: 1, minSize: 0 },
            { component: mascotArea, basis: "auto", shrink: 0 },
        ]);
        const transcriptLayout = new HStack([
            {
                component: transcriptScrollView,
                basis: 0,
                grow: 1,
                minSize: 48,
            },
            {
                component: rail,
                basis: 22,
                shrink: 0,
                visible: (viewport) =>
                    viewport.width >= MASCOT_RAIL_MIN_WIDTH && viewport.width < SESSION_SIDEBAR_MIN_WIDTH,
            },
            {
                component: rail,
                basis: 34,
                shrink: 0,
                visible: (viewport) => viewport.width >= SESSION_SIDEBAR_MIN_WIDTH,
            },
        ], { gap: 1 });
        tui.setLayoutRoot(
            new VStack([
                {
                    component: transcriptLayout,
                    basis: 0,
                    grow: 1,
                    minSize: 1,
                },
                { component: bottomDock, basis: "auto", shrink: 1, minSize: 1 },
            ]),
        );
    } else {
        tui.addChild(rootWrapper);
    }
    const artifactReaders = new Set<Awaited<ReturnType<typeof startArtifactReadSurface>>>();
    let selectingArtifact = false;
    let disposed = false;
    if (tui instanceof RunWieldTui) {
        tui.onArtifactLink = (link) => {
            if (link.sessionId === options.getSessionId()) void openSessionArtifact(link.artifactId);
        };
    }
    async function openSessionArtifact(selectedId?: string) {
        if (selectingArtifact || (!selectedId && activeInteractionContainer.children.length > 0)) return;
        const snapshot = options.sessionRuntime?.getSessionSnapshot(options.getSessionId());
        if (!snapshot?.artifacts?.length) return;
        selectingArtifact = true;
        try {
            const artifactId = selectedId || await uiAPI.promptSelect(
                "Open artifact",
                snapshot.artifacts.slice().reverse().map((artifact) => ({
                    value: artifact.artifactId,
                    label: artifact.title,
                    description: artifact.path,
                })),
                { persistResult: false },
            );
            const artifact = snapshot.artifacts.find((item) => item.artifactId === artifactId);
            if (!artifact || disposed) return;
            const document = await readSessionArtifact(snapshot.cwd, artifact);
            const surface = await startArtifactReadSurface({
                cwd: snapshot.cwd,
                markdown: document.markdown,
                artifactKind: artifact.kind,
                title: artifact.title,
                path: artifact.path,
                imageBaseDir: document.imageBaseDir,
                browser: SYSTEM_BROWSER_PORT,
            });
            if (disposed) {
                await surface.stop();
                return;
            }
            artifactReaders.add(surface);
            if (!surface.opened) uiAPI.appendSystemMessage(`Open artifact: ${surface.url}`);
            void surface.waitForDecision().finally(async () => {
                artifactReaders.delete(surface);
                await surface.stop();
            }).catch(() => {});
        } catch (error) {
            uiAPI.appendSystemMessage(error instanceof Error ? error.message : String(error), true);
        } finally {
            selectingArtifact = false;
        }
    }
    const removeSidebarKeyListener = tui.addInputListener((data) => {
        if (isSessionArtifactOpenKey(data)) {
            void openSessionArtifact();
            return { consume: true };
        }
        if (!isSessionSidebarCycleKey(data)) return undefined;
        sessionSidebar.cycleTab();
        tui.requestRender();
        return { consume: true };
    });
    tui.setFocus(editor);
    const uiAPI = createUiApi(
        options.documentLinks,
        tui,
        messageList,
        runningTasksComponent,
        inputAccessoryContainer,
        validationPanelContainer,
        activeInteractionContainer,
        queuedInputContainer,
        transcriptScrollView
            ? () =>
                findVisibleToolBlocks(
                    container.renderedChildren,
                    messageList,
                    messageList.renderedChildren,
                    transcriptScrollView.scrollTop,
                    transcriptScrollView.viewportHeight,
                )
            : undefined,
        (progress) => {
            liveValidationProgress = progress;
        },
    );
    const originalSetBusy = uiAPI.setBusy;
    uiAPI.setBusy = (busy) => {
        if (!busy || !runningTasksComponent.isBusy) mascotAnswering = false;
        originalSetBusy?.(busy);
    };
    const originalMessageStart = uiAPI.appendAgentMessageStart;
    uiAPI.appendAgentMessageStart = (agentName) => {
        const appender = originalMessageStart(agentName);
        return {
            ...appender,
            appendText(delta) {
                if (delta && runningTasksComponent.isBusy) mascotAnswering = true;
                appender.appendText(delta);
            },
        };
    };
    const originalThinkingStart = uiAPI.appendThinkingStart;
    uiAPI.appendThinkingStart = () => {
        mascotAnswering = false;
        return originalThinkingStart!();
    };
    const originalToolStart = uiAPI.startToolExecution;
    uiAPI.startToolExecution = (...args) => {
        mascotAnswering = false;
        return originalToolStart!(...args);
    };
    const removeSidebarActionListener = tui.addInputListener((data) => {
        if (!isSessionSidebarActionKey(data)) return undefined;
        const snapshot = options.sessionRuntime?.getSessionSnapshot(options.getSessionId());
        const action = sessionSidebar.currentAction(
            snapshot ? { ...snapshot, validationProgress: liveValidationProgress } : undefined,
        );
        if (!snapshot || !action) return undefined;
        void Promise.resolve(options.onWorkflowAction?.(action, snapshot)).catch((error) => {
            uiAPI.appendSystemMessage(error instanceof Error ? error.message : String(error), true, "Workflow action");
        });
        return { consume: true };
    });
    const baseSetManagedSyncStatus = uiAPI.setManagedSyncStatus?.bind(uiAPI);
    uiAPI.setManagedSyncStatus = (state) => {
        baseSetManagedSyncStatus?.(state);
        editor.disableSubmit = state.status === "blocked" || state.status === "degraded";
    };
    installUiApiOverrides({
        uiAPI,
        tui,
        editor,
        container: composerContainer,
        getProjectRoot: () => {
            if (options.sessionRuntime === null) return options.projectRoot;
            const snapshot = options.sessionRuntime?.getSessionSnapshot(options.getSessionId());
            if (!snapshot) throw new Error("Active runtime session is missing.");
            return snapshot.cwd;
        },
        setActiveModel: options.setActiveModel,
        getActiveModelState: () => {
            if (options.sessionRuntime === null) {
                const settings = getSettingsManager(options.projectRoot);
                return { model: settings.getDefaultModel() || "", provider: settings.getDefaultProvider() || "" };
            }
            const snapshot = options.sessionRuntime?.getSessionSnapshot(options.getSessionId());
            if (!snapshot) throw new Error("Active runtime session is missing.");
            return { model: snapshot.activeModel.model || "", provider: snapshot.activeModel.provider || "" };
        },
    });
    options.configureUiAPI?.(uiAPI);
    const basePromptSelect = uiAPI.promptSelect?.bind(uiAPI);
    if (basePromptSelect) {
        uiAPI.promptSelect = async (title, promptOptions, hooks) => {
            const result = await basePromptSelect(title, promptOptions, hooks);
            tui.setFocus(editor);
            tui.requestRender();
            return result;
        };
    }
    const basePromptText = uiAPI.promptText?.bind(uiAPI);
    if (basePromptText) {
        uiAPI.promptText = async (title, promptOptions) => {
            const result = await basePromptText(title, promptOptions);
            tui.setFocus(editor);
            tui.requestRender();
            return result;
        };
    }
    const unsubscribeThemeChange = onThemeChange(() => {
        tui.invalidate();
        tui.requestRender();
    });
    let clipboardCheckInFlight = false;
    async function refreshClipboardImageHint(): Promise<void> {
        if (clipboardCheckInFlight) return;
        clipboardCheckInFlight = true;
        try {
            const nextClipboardImageAvailable = await hasClipboardImage();
            if (nextClipboardImageAvailable !== clipboardImageAvailable) {
                clipboardImageAvailable = nextClipboardImageAvailable;
                tui.requestRender();
            }
        } catch {
            if (clipboardImageAvailable) {
                clipboardImageAvailable = false;
                tui.requestRender();
            }
        } finally {
            clipboardCheckInFlight = false;
        }
    }
    void refreshClipboardImageHint();
    const clipboardPollingInterval = setInterval(() => void refreshClipboardImageHint(), 1500);
    Object.assign(editor, {
        onFocus: () => {
            try {
                tui.requestRender();
            } catch { /* no action */ }
        },
        onBlur: () => {
            try {
                tui.requestRender();
            } catch { /* no action */ }
        },
        onChange: () => {
            try {
                tui.requestRender();
            } catch { /* no action */ }
        },
    });
    return {
        uiAPI,
        tui,
        editor,
        container,
        footerContainer,
        messageList,
        validationPanelContainer,
        runningTasksComponent,
        activeInteractionContainer,
        inputAccessoryContainer,
        previewImages,
        pastedImages,
        installAutocompleteProvider(provider) {
            editor.setAutocompleteProvider(provider);
        },
        addPastedImagePreview(image) {
            pastedImages.push(image);
            previewImages.addChild(createPastedImagePreview(image));
        },
        clearPastedImages() {
            pastedImages.length = 0;
            previewImages.clear();
        },
        resetForSessionReplacement() {
            mascotAnswering = false;
            pastedImages.length = 0;
            previewImages.clear();
            snapshotWindow?.rebind();
            snapshotWindow?.invalidate();
            uiAPI.hideKeyboardHelp?.();
            uiAPI.clearValidationPanel?.();
            uiAPI.clearMessages?.();
            editor.setText("");
            tui.setFocus(editor);
            tui.requestRender();
        },
        focusEditor() {
            tui.setFocus(editor);
        },
        requestRender() {
            tui.requestRender();
        },
        dispose() {
            disposed = true;
            mascot.dispose();
            for (const surface of artifactReaders) void Promise.resolve(surface.stop()).catch(() => {});
            artifactReaders.clear();
            if (tui instanceof RunWieldTui) tui.onArtifactLink = undefined;
            snapshotWindow?.dispose();
            removeSidebarKeyListener();
            removeSidebarActionListener();
            clearInterval(clipboardPollingInterval);
            unsubscribeThemeChange();
            if (isViewportTUI(tui)) tui.setLayoutRoot(undefined);
            endBlink();
        },
    };
}
