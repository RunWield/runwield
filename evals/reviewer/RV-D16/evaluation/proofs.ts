import assert from "node:assert/strict";

if (process.argv[2] !== "local-reminder-day") throw new Error("Select local-reminder-day");
const moduleUrl = new URL("../src/reminders.ts", import.meta.url).href;
const script = `
    const { remindersForDay } = await import(${JSON.stringify(moduleUrl)});
    const events = [{ title: "Evening review", startsAt: "2026-01-15T01:30:00.000Z" }];
    console.log(JSON.stringify({
        localDay: remindersForDay(events, "2026-01-14"),
        nextDay: remindersForDay(events, "2026-01-15"),
    }));
`;
// The timezone belongs to a child, not to the proof runner or the Reviewer host.
const child = Bun.spawn([process.execPath, "--eval", script], {
    env: { ...process.env, TZ: "America/Los_Angeles" },
    stdout: "pipe",
    stderr: "pipe",
});
const [output, error, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
]);
assert.equal(code, 0, "Reminder child must complete: " + error);
assert.deepEqual(
    JSON.parse(output),
    {
        localDay: ["Evening review"],
        nextDay: [],
    },
    "RV-D16-LOCAL-REMINDER-DAY",
);
console.log("PASS local-reminder-day");
