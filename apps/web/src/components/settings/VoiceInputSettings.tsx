import { DownloadIcon, MicIcon, Trash2Icon, XIcon } from "lucide-react";
import { useCallback, useState } from "react";

import { readLocalApi } from "../../localApi";
import { useDesktopSpeechState } from "../../state/desktopSpeechState";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardFooter, CardHeader, CardPanel } from "../ui/card";
import { Separator } from "../ui/separator";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";

const bytes = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

export function VoiceInputSettings(_props: { highlightRecommended?: boolean }) {
  const localApi = readLocalApi();
  const speech = localApi?.speech;
  const state = useDesktopSpeechState();
  const [pending, setPending] = useState(false);
  const model = state?.models[0];

  const run = useCallback(
    async (action: "download" | "cancel" | "delete") => {
      if (!speech || !model || !localApi) return;
      setPending(true);
      try {
        if (action === "delete") {
          const confirmed = await localApi.dialogs.confirm(
            `Delete ${model.catalogEntry.title} from this device?`,
          );
          if (!confirmed) return;
        }
        const result =
          action === "download"
            ? await speech.downloadModel(model.catalogEntry.id)
            : action === "cancel"
              ? await speech.cancelDownload(model.catalogEntry.id)
              : await speech.removeModel(model.catalogEntry.id);
        if (result.type === "rejected") {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Voice input action failed",
              description: result.message,
            }),
          );
        }
      } catch {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Voice input action failed",
            description: "The desktop voice service could not complete the action.",
          }),
        );
      } finally {
        setPending(false);
      }
    },
    [localApi, model, speech],
  );

  const openLicense = useCallback(() => {
    if (!model) return;
    void localApi?.shell.openExternal(model.catalogEntry.license.sourceUrl).catch(() => {
      toastManager.add({
        type: "error",
        title: "Could not open license",
        description: "The model license link could not be opened.",
      });
    });
  }, [localApi, model]);

  if (!speech) return null;

  const failure =
    model?.download.type === "failed"
      ? model.download.reason
      : model?.installation.type === "remove-failed"
        ? model.installation.reason
        : null;
  const busy = state?.session.type !== "idle";

  return (
    <SettingsPageContainer>
      <SettingsSection
        id="voice-input"
        title="Voice Input"
        icon={<MicIcon className="size-5 text-muted-foreground" />}
      >
        <div className="rounded-xl px-3 py-3 sm:px-4">
          <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
            Download the local Moonshine model to dictate prompts with live transcription. Audio and
            speech processing stay on this device, and text is sent only when you submit.
          </p>
        </div>

        {state === null ? (
          <p role="status" className="rounded-xl px-4 py-6 text-sm text-muted-foreground">
            Loading voice input…
          </p>
        ) : state.availability.type === "unsupported" ? (
          <div
            role="status"
            className="rounded-xl border border-warning/30 bg-warning/5 px-4 py-4 text-sm"
          >
            <p className="font-medium">Voice input is unavailable</p>
            <p className="mt-1 text-muted-foreground">{state.availability.reason}</p>
          </div>
        ) : model ? (
          <Card className="overflow-hidden">
            <CardHeader className="gap-2 p-4 sm:p-5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="font-semibold">{model.catalogEntry.title}</h3>
                  <p className="mt-1 text-[13px] text-muted-foreground">
                    {model.catalogEntry.description}
                  </p>
                </div>
                <Badge variant="outline">
                  {model.download.type === "downloading"
                    ? `Downloading ${model.download.percent}%`
                    : model.download.type === "canceling"
                      ? "Canceling"
                      : model.installation.type === "installed"
                        ? "Ready"
                        : model.installation.type === "removing"
                          ? "Deleting"
                          : "Not downloaded"}
                </Badge>
              </div>
            </CardHeader>

            <CardPanel className="space-y-3 px-4 pb-4 sm:px-5 sm:pb-5">
              <p className="text-xs text-muted-foreground">
                {bytes.format(model.catalogEntry.artifact.bytes)} bytes · English · Q8_0 ·{" "}
                <button
                  type="button"
                  className="underline underline-offset-2 hover:text-foreground"
                  onClick={openLicense}
                >
                  MIT license
                </button>
              </p>
              {model.download.type === "downloading" ? (
                <div
                  role="progressbar"
                  aria-label="Downloading voice model"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={model.download.percent}
                  className="h-1.5 overflow-hidden rounded-full bg-muted"
                >
                  <div
                    className="h-full bg-primary"
                    style={{ width: `${model.download.percent}%` }}
                  />
                </div>
              ) : null}
              {failure ? (
                <p role="status" className="text-xs text-destructive">
                  {failure}
                </p>
              ) : null}
            </CardPanel>

            <Separator />
            <CardFooter className="justify-end gap-2 px-4 py-3 sm:px-5">
              {model.download.type === "downloading" || model.download.type === "canceling" ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pending || model.download.type === "canceling"}
                  onClick={() => void run("cancel")}
                >
                  <XIcon /> Cancel
                </Button>
              ) : model.installation.type === "installed" ||
                model.installation.type === "remove-failed" ? (
                <Button
                  size="sm"
                  variant="destructive-outline"
                  disabled={pending || busy}
                  onClick={() => void run("delete")}
                >
                  <Trash2Icon /> Delete
                </Button>
              ) : (
                <Button size="sm" disabled={pending} onClick={() => void run("download")}>
                  <DownloadIcon /> {model.download.type === "failed" ? "Retry" : "Download"}
                </Button>
              )}
            </CardFooter>
          </Card>
        ) : null}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
