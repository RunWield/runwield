import { test } from "node:test";
import { ok as assert, match as assertMatch } from "node:assert/strict";
import { assertEquals, assertRejects } from "../../testing/assertions.ts";
import { HostedSession } from "../../shared/session/hosted-session.js";
import { createTriageReportTool } from "../triage-report.ts";
import { makeToolProjectFixture, withWorkflowMetricsFixture } from "../../testing/workflow-metrics-fixture.ts";

const TRIAGE_PROJECT_ROOT = makeToolProjectFixture("runwield-triage-report-");

test("createTriageReportTool exposes expected metadata", () => {
    const tool = createTriageReportTool();
    assertEquals(tool.name, "triage_report");
    assertEquals(tool.label, "Routing Intent Report");
    assertMatch(tool.description, /MUST call this tool exactly once/i);
    assertMatch(tool.description, /Routing Intent/i);
    assertEquals(typeof tool.execute, "function");
    assertEquals(typeof tool.parameters, "object");
    assert("classification" in tool.parameters.properties);
    assert(!tool.parameters.required.includes("routingIntent"));
    assert(!tool.parameters.required.includes("sessionName"));
});

test("createTriageReportTool called with no opts produces valid tool shape", () => {
    const tool = createTriageReportTool({});
    assertEquals(tool.name, "triage_report");
    assertEquals(typeof tool.execute, "function");
});

test("createTriageReportTool instances are independent", () => {
    const t1 = createTriageReportTool();
    const t2 = createTriageReportTool();
    assertEquals(t1.name, t2.name);
    // Different closures — same shape
    assertEquals(typeof t1.execute, typeof t2.execute);
});

test("triage_report execute returns canonical routingIntent details for INQUIRY", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot, readMetrics }) => {
        /** @type {any[]} */
        const events = [];
        const hostedSession = new HostedSession({ id: "triage-inquiry", cwd: projectRoot });
        hostedSession.setEventSink({ emit: (/** @type {any} */ event) => events.push(event) });
        const tool = createTriageReportTool({ hostedSession });

        const params = {
            routingIntent: /** @type {const} */ ("INQUIRY"),
            complexity: /** @type {const} */ ("LOW"),
            summary: "explain routing",
            sessionName: "routing overview",
        };

        const result = await /** @type {any} */ (tool.execute)("call-1", params);

        assertEquals(result.terminate, true);
        assertEquals(result.details, params);
        assert(!("classification" in result.details));
        assertMatch(result.content[0].text, /Triage complete/);
        assertEquals(events.length, 2);
        assertEquals(events[1].message, "\n\nRouting Intent: INQUIRY\nComplexity: LOW\nSummary: explain routing");
        const metrics = await readMetrics();
        assertEquals(metrics.length, 1);
        assertEquals(metrics[0].category, "routing");
        assertEquals(metrics[0].event, "triage_reported");
        assertEquals(metrics[0].details?.routingIntent, "INQUIRY");
    });
});

test("triage_report execute records workflow context when a HostedSession is available", async () => {
    const hostedSession = new HostedSession({ id: "triage-context", cwd: TRIAGE_PROJECT_ROOT });
    const tool = createTriageReportTool({ hostedSession });

    await /** @type {any} */ (tool.execute)("call-1", {
        routingIntent: "QUICK_FIX",
        complexity: "LOW",
        summary: "fix typo",
        sessionName: "fix typo",
    });

    assertEquals(hostedSession.getWorkflowContext(), {
        routingIntent: "QUICK_FIX",
        complexity: "LOW",
        summary: "fix typo",
    });
});

test("triage_report accepts documentation Work Kind only for planned changes", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot, readMetrics }) => {
        /** @type {any[]} */
        const events = [];
        const hostedSession = new HostedSession({ id: "triage-documentation", cwd: projectRoot });
        hostedSession.setEventSink({ emit: (/** @type {any} */ event) => events.push(event) });
        const tool = createTriageReportTool({ hostedSession });

        const planned = await /** @type {any} */ (tool.execute)("call-1", {
            routingIntent: "PLANNED_CHANGE",
            workKind: "DOCUMENTATION",
            complexity: "MEDIUM",
            summary: "refresh public docs",
            sessionName: "refresh docs",
        });
        const operation = await /** @type {any} */ (tool.execute)("call-2", {
            routingIntent: "OPERATION",
            workKind: "DOCUMENTATION",
            complexity: "LOW",
            summary: "read docs",
            sessionName: "read docs",
        });

        assertEquals(planned.details.workKind, "DOCUMENTATION");
        assertEquals(
            events[1].message,
            "\n\nRouting Intent: PLANNED_CHANGE\nWork Kind: DOCUMENTATION\nComplexity: MEDIUM\nSummary: refresh public docs",
        );
        assertEquals(operation.details.routingIntent, "OPERATION");
        assertEquals(operation.details.workKind, undefined);
        const metrics = await readMetrics();
        assertEquals(metrics[0].details?.workKind, "DOCUMENTATION");
        assertEquals(metrics[1].details?.workKind, undefined);
    });
});

test("triage_report execute preserves plan classification only for PLANNED_CHANGE and PROJECT", async () => {
    const tool = createTriageReportTool();

    const feature = await /** @type {any} */ (tool.execute)("call-1", {
        routingIntent: "FEATURE",
        complexity: "MEDIUM",
        summary: "plan feature",
        sessionName: "plan feature",
    });
    const operation = await /** @type {any} */ (tool.execute)("call-2", {
        routingIntent: "OPERATION",
        complexity: "LOW",
        summary: "show status",
        sessionName: "show status",
    });
    const quickFix = await /** @type {any} */ (tool.execute)("call-3", {
        routingIntent: "QUICK_FIX",
        complexity: "LOW",
        summary: "fix typo",
        sessionName: "fix typo",
    });

    assertEquals(feature.details.routingIntent, "PLANNED_CHANGE");
    assertEquals(feature.details.classification, "PLANNED_CHANGE");
    assertEquals(operation.details.routingIntent, "OPERATION");
    assert(!("classification" in operation.details));
    assertEquals(quickFix.details.routingIntent, "QUICK_FIX");
    assert(!("classification" in quickFix.details));
});

test("triage_report execute normalizes legacy classification params", async () => {
    const tool = createTriageReportTool();

    const legacyFeature = await /** @type {any} */ (tool.execute)("call-0", {
        classification: "FEATURE",
        complexity: "MEDIUM",
        summary: "legacy feature",
        sessionName: "legacy feature",
    });
    const result = await /** @type {any} */ (tool.execute)("call-1", {
        classification: "PROJECT",
        complexity: "HIGH",
        summary: "legacy project",
        sessionName: "legacy project",
    });

    assertEquals(legacyFeature.details.routingIntent, "PLANNED_CHANGE");
    assertEquals(legacyFeature.details.classification, "PLANNED_CHANGE");
    assertEquals(result.details.routingIntent, "PROJECT");
    assertEquals(result.details.classification, "PROJECT");
});

test("triage_report execute sanitizes sessionName when provided and omits it when absent", async () => {
    const tool = createTriageReportTool();

    const sanitized = await /** @type {any} */ (tool.execute)("call-1", {
        routingIntent: "INQUIRY",
        complexity: "LOW",
        summary: "explain routing",
        sessionName: " explain\n\trouting\u0007 ",
    });
    const omitted = await /** @type {any} */ (tool.execute)("call-2", {
        routingIntent: "INQUIRY",
        complexity: "LOW",
        summary: "explain routing",
    });

    assertEquals(sanitized.details.sessionName, "explain routing");
    assertEquals(omitted.details.sessionName, undefined);
});

test("triage_report execute rejects params without canonical or legacy intent", async () => {
    const tool = createTriageReportTool();

    await assertRejects(
        () =>
            /** @type {any} */ (tool.execute)("call-1", {
                complexity: "LOW",
                summary: "missing intent",
            }),
        TypeError,
        "routingIntent",
    );
});
