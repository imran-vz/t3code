import * as Schema from "effect/Schema";
import { describe, expect, expectTypeOf, it } from "vite-plus/test";

import type { DesktopBridge, DesktopSpeechBridge, LocalApi } from "./ipc.ts";
import { DesktopEnvironmentBootstrapSchema } from "./ipc.ts";

describe("DesktopEnvironmentBootstrapSchema", () => {
  const decode = Schema.decodeUnknownSync(DesktopEnvironmentBootstrapSchema);

  it("preserves the concrete running distro separately from the backend id", () => {
    expect(
      decode({
        id: "wsl:default",
        label: "WSL (Ubuntu)",
        runningDistro: "Ubuntu",
        httpBaseUrl: "http://127.0.0.1:3774/",
        wsBaseUrl: "ws://127.0.0.1:3774/",
      }),
    ).toEqual({
      id: "wsl:default",
      label: "WSL (Ubuntu)",
      runningDistro: "Ubuntu",
      httpBaseUrl: "http://127.0.0.1:3774/",
      wsBaseUrl: "ws://127.0.0.1:3774/",
    });
  });

  it("allows non-running and non-WSL bootstraps to report no running distro", () => {
    expect(
      decode({
        id: "primary",
        label: "Windows",
        runningDistro: null,
        httpBaseUrl: null,
        wsBaseUrl: null,
      }).runningDistro,
    ).toBeNull();
  });
});

describe("desktop speech IPC capability", () => {
  it("exposes the desktop bridge and keeps the LocalApi capability optional", () => {
    expectTypeOf<DesktopBridge["speech"]>().toEqualTypeOf<DesktopSpeechBridge>();
    expectTypeOf<LocalApi["speech"]>().toEqualTypeOf<DesktopSpeechBridge | undefined>();
  });
});
