/** Private UI projections. Main validates locators against admitted bindings. */
export interface DesktopNavigation {
    collapsed: boolean;
    expandedProjects: string[];
    selectedProjectId: string;
    selectedSessionId: string;
    showSession: boolean;
}
export interface DesktopWorkbenchClient {
    read(): Promise<DesktopNavigation>;
    write(navigation: DesktopNavigation): Promise<void>;
    restartRuntime(): Promise<void>;
    onNewSession(listener: () => void): () => void;
    flushDrafts(listener: () => Promise<void>): () => void;
}
