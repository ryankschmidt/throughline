const marker = "  // ThroughLine desktop window tint";
const endMarker = "  // End ThroughLine desktop window tint\n";

function tintBlock(channels: ReadonlyArray<number>) {
  return `${marker}
  override func scene(
    _ scene: UIScene,
    willConnectTo session: UISceneSession,
    options connectionOptions: UIScene.ConnectionOptions
  ) {
    super.scene(scene, willConnectTo: session, options: connectionOptions)
    window?.tintColor = UIColor(red: ${channels[0]}.0 / 255.0, green: ${channels[1]}.0 / 255.0, blue: ${channels[2]}.0 / 255.0, alpha: 1)
  }
  // End ThroughLine desktop window tint
`;
}

export function addDesktopWindowTint(source: string, accent: string): string {
  if (!/^#[0-9a-f]{6}$/i.test(accent)) throw new Error("PHONE_NATIVE_TINT_INVALID_ACCENT");
  const refuse = () => {
    throw new Error("PHONE_NATIVE_TINT_SCENE_ANCHOR_CHANGED");
  };
  if (
    (source.match(/^class SceneDelegate: ExpoAppSceneDelegate \{$/gm) ?? []).length !== 1 ||
    source.split("internal import Expo\n").length !== 2
  )
    refuse();
  if (source.includes(marker)) {
    if (
      source.split(marker).length !== 2 ||
      source.split(endMarker).length !== 2 ||
      source.split("internal import UIKit\n").length !== 2
    )
      refuse();
    const start = source.indexOf(marker);
    const end = source.indexOf(endMarker, start) + endMarker.length;
    const old = source.slice(start, end);
    const rgb = old.match(
      /UIColor\(red: (\d+)\.0 \/ 255\.0, green: (\d+)\.0 \/ 255\.0, blue: (\d+)\.0 \/ 255\.0, alpha: 1\)/,
    );
    if (!rgb) refuse();
    const previous = rgb!.slice(1).map(Number);
    if (previous.some((value) => value < 0 || value > 255) || old !== tintBlock(previous)) refuse();
    source = source.slice(0, start) + source.slice(end);
    source = source.replace("internal import UIKit\n", "");
  }
  const anchor = "  // Extension point for config plugins.\n";
  if (
    source.split(anchor).length !== 2 ||
    source.includes("willConnectTo") ||
    source.includes("internal import UIKit\n") ||
    source.includes(endMarker)
  )
    refuse();
  const addition = tintBlock([1, 3, 5].map((at) => Number.parseInt(accent.slice(at, at + 2), 16)));
  return source
    .replace("internal import Expo\n", "internal import Expo\ninternal import UIKit\n")
    .replace(anchor, anchor + addition);
}
