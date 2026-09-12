// Only the known, selected local-development notice may be acknowledged.
// Trust dialogs, tool approvals, policy blocks and changed layouts stay manual.
export function localDevelopmentNotice(output: string): boolean {
  const text = output
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\s+/g, "");
  return (
    text.includes("WARNING:Loadingdevelopmentchannels") &&
    text.includes(
      "--dangerously-load-development-channelsisforlocalchanneldevelopmentonly.",
    ) &&
    text.includes(
      "Channels:server:sidewalk❯1.Iamusingthisforlocaldevelopment2.Exit",
    ) &&
    text.includes("Entertoconfirm·Esctocancel") &&
    !text.includes("blockedbyorgpolicy")
  );
}
