import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { PanResponder, View, useWindowDimensions, type LayoutChangeEvent } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useKeyboardState } from "react-native-keyboard-controller";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../state/preferences";
import {
  clampComposerHeight,
  composerHeightBounds,
  DEFAULT_COMPOSER_EDITOR_HEIGHT,
  dragComposerHeight,
} from "./composerHeight";

/** Resize only the existing editor. Persist on release, never on every pointer move. */
export function useComposerResize(reservedOutsideHeight: number | undefined) {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const savedHeight = AsyncResult.isSuccess(preferences)
    ? preferences.value.composerEditorHeight
    : undefined;
  const [preferredHeight, setPreferredHeight] = useState(DEFAULT_COMPOSER_EDITOR_HEIGHT);
  const [dragging, setDragging] = useState(false);
  const [chromeHeight, setChromeHeight] = useState(110);
  const touched = useRef(false);
  useEffect(() => {
    if (!touched.current && savedHeight !== undefined) setPreferredHeight(savedHeight);
  }, [savedHeight]);
  const window = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const keyboardHeight = useKeyboardState((state) => (state.isVisible ? state.height : 0));
  // Reserve the navigation header and measured toolbar/attachments, not an arbitrary fraction.
  const bounds = useMemo(
    () =>
      composerHeightBounds(
        window.height,
        keyboardHeight,
        (reservedOutsideHeight ?? insets.top + 80) + chromeHeight,
      ),
    [window.height, keyboardHeight, insets.top, reservedOutsideHeight, chromeHeight],
  );
  const height = clampComposerHeight(preferredHeight, bounds);
  const latest = useRef({ height, bounds });
  useLayoutEffect(() => {
    latest.current = { height, bounds };
  }, [height, bounds]);
  const startHeight = useRef(height);
  const persist = useCallback(
    (value: number) => {
      touched.current = true;
      setPreferredHeight(value);
      savePreferences({ composerEditorHeight: value });
    },
    [savePreferences],
  );
  const persistRef = useRef(persist);
  useLayoutEffect(() => {
    persistRef.current = persist;
  }, [persist]);
  const [responder, setResponder] = useState<ReturnType<typeof PanResponder.create> | null>(null);
  useEffect(() => {
    setResponder(
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: () => {
          touched.current = true;
          startHeight.current = latest.current.height;
          setDragging(true);
        },
        onPanResponderMove: (_event, gesture) => {
          setPreferredHeight(
            dragComposerHeight(startHeight.current, gesture.dy, latest.current.bounds),
          );
        },
        onPanResponderRelease: (_event, gesture) => {
          persistRef.current(
            dragComposerHeight(startHeight.current, gesture.dy, latest.current.bounds),
          );
          setDragging(false);
        },
        onPanResponderTerminate: () => {
          persistRef.current(latest.current.height);
          setDragging(false);
        },
        onPanResponderTerminationRequest: () => false,
      }),
    );
  }, []);
  const onRootLayout = (event: LayoutChangeEvent) => {
    const chrome = Math.max(0, event.nativeEvent.layout.height - height);
    setChromeHeight((previous) => (Math.abs(previous - chrome) > 1 ? chrome : previous));
  };
  const handle = (
    <View
      {...responder?.panHandlers}
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel="Message box height"
      accessibilityHint="Drag up to expand your draft or down to see more of the conversation."
      accessibilityValue={{ min: bounds.min, max: bounds.max, now: height }}
      accessibilityActions={[
        { name: "increment", label: "Make taller" },
        { name: "decrement", label: "Make shorter" },
      ]}
      onAccessibilityAction={(event) => {
        const delta = event.nativeEvent.actionName === "increment" ? 40 : -40;
        persist(clampComposerHeight(height + delta, bounds));
      }}
      className="items-center justify-center"
      style={{ height: 44 }}
    >
      <View
        className={dragging ? "rounded-full bg-foreground" : "rounded-full bg-foreground-muted"}
        style={{ width: 44, height: 4 }}
      />
    </View>
  );
  return { height, dragging, handle, onRootLayout };
}
