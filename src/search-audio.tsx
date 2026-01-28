import { Action, ActionPanel, Icon, List, Toast, showToast } from "@raycast/api";
import { runAppleScript, showFailureToast, useCachedPromise } from "@raycast/utils";
import { spawn } from "child_process";
import { useMemo, useState } from "react";
import { AudioTrackDto, buildShareableLink, fetchAudioCatalog, fetchAudioFile } from "./medicbot";

function buildKeywords(track: AudioTrackDto) {
  return [track.id, ...(track.aliases ?? []), ...(track.tags ?? [])].filter(Boolean);
}

function buildAccessories(track: AudioTrackDto) {
  const accessories: List.Item.Accessory[] = [];
  if (track.isFavorite) {
    accessories.push({ icon: Icon.Star, tooltip: "Favorite" });
  }
  if (track.tags?.length) {
    accessories.push({ text: track.tags.slice(0, 2).join(", ") });
  }
  return accessories;
}

export default function SearchAudio() {
  const { data, isLoading, revalidate, error } = useCachedPromise(fetchAudioCatalog, [], {
    keepPreviousData: true,
    onError: (error) => {
      showFailureToast(error, { title: "MedicBot error" });
      console.error("Error fetching audio catalog:", error);
    },
  });

  const tracks = useMemo(() => data ?? [], [data]);
  const [quickLookPaths, setQuickLookPaths] = useState<Record<string, string>>({});

  const emptyTitle = error ? "Setup required" : "No audio found";
  const emptyDescription = error instanceof Error ? error.message : "Try a different search term.";

  const spawnPlayer = async (command: string, args: string[]) => {
    await new Promise<void>((resolve, reject) => {
      const env = {
        ...process.env,
        PATH: [process.env.PATH, "/usr/bin", "/opt/homebrew/bin", "/usr/local/bin"].filter(Boolean).join(":"),
      };
      const child = spawn(command, args, { stdio: "ignore", env });
      child.on("error", reject);
      child.on("spawn", () => {
        child.unref();
        resolve();
      });
    });
  };

  const handlePlay = async (track: AudioTrackDto, player: "afplay" | "ffplay") => {
    const toast = await showToast({ style: Toast.Style.Animated, title: "Preparing audio", message: track.name });
    try {
      if (player === "afplay" && process.platform !== "darwin") {
        toast.style = Toast.Style.Failure;
        toast.title = "Audio playback unavailable";
        toast.message = "afplay is only available on macOS.";
        return;
      }
      const filePath = await fetchAudioFile(track.id);
      if (player === "afplay") {
        await spawnPlayer("/usr/bin/afplay", [filePath]);
      } else {
        await spawnPlayer("ffplay", ["-nodisp", "-autoexit", filePath]);
      }
      toast.style = Toast.Style.Success;
      toast.title = "Playing audio";
      toast.message = track.name;
    } catch (previewError) {
      const error = previewError as NodeJS.ErrnoException;
      console.error("Error playing audio:", previewError);
      toast.style = Toast.Style.Failure;
      toast.title = "Audio playback failed";
      if (error?.code === "ENOENT") {
        toast.message = player === "afplay" ? "afplay not found on this system." : "ffplay not found. Install FFmpeg.";
      } else {
        toast.message = previewError instanceof Error ? previewError.message : "Unknown error";
      }
    }
  };

  const toggleQuickLook = async () => {
    await runAppleScript(`
      tell application "System Events"
        tell process "Raycast" to keystroke "y" using {command down}
      end tell
    `);
  };

  const handleQuickLookPreview = async (track: AudioTrackDto) => {
    const toast = await showToast({ style: Toast.Style.Animated, title: "Preparing Quick Look", message: track.name });
    try {
      if (process.platform !== "darwin") {
        toast.style = Toast.Style.Failure;
        toast.title = "Quick Look unavailable";
        toast.message = "Quick Look previews require macOS.";
        return;
      }
      const filePath = await fetchAudioFile(track.id);
      setQuickLookPaths((current) => ({ ...current, [track.id]: filePath }));
      await new Promise((resolve) => setTimeout(resolve, 100));
      await toggleQuickLook();
      toast.style = Toast.Style.Success;
      toast.title = "Quick Look opened";
      toast.message = track.name;
    } catch (previewError) {
      console.error("Error preparing Quick Look:", previewError);
      toast.style = Toast.Style.Failure;
      toast.title = "Quick Look failed";
      if (previewError instanceof Error && previewError.message.includes("System Events")) {
        toast.message = "Enable Accessibility permissions for Raycast.";
      } else {
        toast.message = previewError instanceof Error ? previewError.message : "Unknown error";
      }
    }
  };

  return (
    <List isLoading={isLoading} searchBarPlaceholder="Search audio by name, alias, tag, or ID">
      <List.EmptyView title={emptyTitle} description={emptyDescription} />
      {tracks.map((track) => (
        <List.Item
          key={track.id}
          title={track.name}
          subtitle={track.id}
          keywords={buildKeywords(track)}
          accessories={buildAccessories(track)}
          quickLook={quickLookPaths[track.id] ? { path: quickLookPaths[track.id] } : undefined}
          actions={
            <ActionPanel>
              <Action.CopyToClipboard title="Copy Shareable Link" content={buildShareableLink(track.id)} />
              <Action
                title="Preview in Raycast (Quick Look)"
                icon={Icon.Eye}
                onAction={() => handleQuickLookPreview(track)}
              />
              <Action.ToggleQuickLook shortcut={{ modifiers: ["cmd"], key: "y" }} />
              <Action title="Play Audio (Afplay)" icon={Icon.Play} onAction={() => handlePlay(track, "afplay")} />
              <Action title="Play Audio (Ffplay)" icon={Icon.PlayFilled} onAction={() => handlePlay(track, "ffplay")} />
              <Action.OpenInBrowser title="Open Shareable Link" url={buildShareableLink(track.id)} />
              <Action title="Refresh" icon={Icon.ArrowClockwise} onAction={revalidate} />
            </ActionPanel>
          }
        />
      ))}
    </List>
  );
}
