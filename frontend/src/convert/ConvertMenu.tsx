/**
 * Two-stage "Convert to..." menu.
 *
 * The ContextMenu primitive has no nested submenus, so a parent menu's
 * "Convert to..." item calls `openAt(position, target)` and this hook renders a
 * SECOND ContextMenu at the same spot listing the valid target formats for that
 * item's media kind (filtered by the backend's source-kind -> target-kind
 * rules), grouped by kind. Selecting one runs the conversion and downloads it.
 */
import { useEffect, useState } from 'react';
import { ContextMenu } from '../components/ui/ContextMenu';
import type { ContextMenuItem, ContextMenuPosition } from '../components/ui/ContextMenu';
import { convertLibraryEntry, formatsForKind, loadConvertFormats } from './convertClient';
import type { ConvertCatalog, ConvertFormat } from './convertClient';

export interface ConvertTarget {
  entryId: string;
  title: string;
  /** 'audio' | 'video' | 'image' (or 'unknown' to offer everything). */
  kind: string;
}

interface UseConvertMenuOptions {
  /** Called when a conversion starts (e.g. to show a toast / log line). */
  onStart?: (message: string) => void;
  /** Called when a conversion fails. */
  onError?: (message: string) => void;
}

export function useConvertMenu(opts: UseConvertMenuOptions = {}) {
  const [state, setState] = useState<{ pos: ContextMenuPosition; target: ConvertTarget } | null>(
    null,
  );
  const [catalog, setCatalog] = useState<ConvertCatalog | null>(null);

  useEffect(() => {
    loadConvertFormats()
      .then(setCatalog)
      .catch(() => {
        /* formats fetched lazily; failure just yields an empty menu */
      });
  }, []);

  const openAt = (pos: ContextMenuPosition, target: ConvertTarget) => setState({ pos, target });
  const close = () => setState(null);

  let element: React.ReactNode = null;
  if (state && catalog) {
    const formats = formatsForKind(catalog, state.target.kind);
    const byKind: Record<string, ConvertFormat[]> = {};
    for (const f of formats) (byKind[f.kind] ??= []).push(f);

    const items: ContextMenuItem[] = [];
    for (const kind of ['audio', 'video', 'image']) {
      const list = byKind[kind];
      if (!list?.length) continue;
      if (Object.keys(byKind).length > 1) items.push({ type: 'header', label: kind });
      for (const f of list) {
        items.push({
          type: 'item',
          label: f.label,
          onSelect: () => {
            opts.onStart?.(`Converting "${state.target.title}" to ${f.label}...`);
            convertLibraryEntry(state.target.entryId, f, state.target.title).catch((e) => {
              opts.onError?.(
                `Convert to ${f.label} failed: ${e instanceof Error ? e.message : String(e)}`,
              );
            });
          },
        });
      }
    }

    if (items.length === 0) {
      items.push({ type: 'header', label: 'No conversions available' });
    }

    element = (
      <ContextMenu
        position={state.pos}
        onClose={close}
        items={items}
        title={`Convert · ${state.target.title}`}
      />
    );
  }

  return { openAt, close, element };
}
