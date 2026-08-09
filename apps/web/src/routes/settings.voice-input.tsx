import { createFileRoute, redirect } from "@tanstack/react-router";

import { VoiceInputSettings } from "../components/settings/VoiceInputSettings";
import { readLocalApi } from "../localApi";

export interface VoiceInputSearch {
  readonly highlight?: "recommended";
}

export const Route = createFileRoute("/settings/voice-input")({
  beforeLoad: () => {
    if (readLocalApi()?.speech === undefined) {
      throw redirect({ to: "/settings/general", replace: true });
    }
  },
  validateSearch: (search): VoiceInputSearch =>
    search.highlight === "recommended" ? { highlight: "recommended" } : {},
  component: VoiceInputSettingsRoute,
});

function VoiceInputSettingsRoute() {
  const search = Route.useSearch();
  return <VoiceInputSettings highlightRecommended={search.highlight === "recommended"} />;
}
