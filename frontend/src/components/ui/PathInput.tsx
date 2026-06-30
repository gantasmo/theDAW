import React, { useState } from 'react';
import { FolderOpen, FileSearch, Loader2 } from 'lucide-react';
import { pickFile, pickFolder } from '../../lib/storageClient';

interface PathInputProps {
  id: string;
  name: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  kind: 'folder' | 'file';
  placeholder?: string;
  description?: string;
  disabled?: boolean;
  onBlur?: () => void;
  onEnter?: () => void;
  className?: string;
  /** Render label + input on one row (compact). Implies descriptionHover. */
  inline?: boolean;
  /** Move the description into a hover tooltip instead of a visible paragraph. */
  descriptionHover?: boolean;
  /** OpenFileDialog filter for kind='file' (e.g. project/audio types). Defaults
   *  to all files on the backend when omitted. */
  fileFilter?: string;
}

export const PathInput: React.FC<PathInputProps> = ({
  id,
  name,
  label,
  value,
  onChange,
  kind,
  placeholder,
  description,
  disabled = false,
  onBlur,
  onEnter,
  className = '',
  inline = false,
  descriptionHover = false,
  fileFilter,
}) => {
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const browse = async () => {
    if (disabled || picking) return;
    setPicking(true);
    setError(null);
    try {
      const result =
        kind === 'folder'
          ? await pickFolder()
          : await pickFile(fileFilter ? { filter: fileFilter } : undefined);
      if (!result.cancelled && result.path) onChange(result.path);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPicking(false);
    }
  };

  const buttonLabel = kind === 'folder' ? `Browse for ${label} folder` : `Browse for ${label} file`;
  // Inline implies the description lives in a hover tooltip rather than a
  // visible paragraph, so the field reclaims its horizontal/vertical space.
  const descAsHover = inline || descriptionHover;
  const hoverTitle = descAsHover ? description : undefined;

  return (
    <div className={`${inline ? 'flex flex-wrap items-center gap-x-2 gap-y-1' : 'flex flex-col gap-1'} ${className}`}>
      <label
        htmlFor={id}
        title={hoverTitle}
        className={`text-[9px] font-mono uppercase tracking-wider text-zinc-400 ${inline ? 'shrink-0' : ''} ${descAsHover && description ? 'cursor-help' : ''}`}
      >
        {label}
      </label>
      <div className={`flex gap-1.5 ${inline ? 'flex-1 min-w-0' : ''}`}>
        <input
          id={id}
          name={name}
          type="text"
          value={value}
          title={hoverTitle}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              if (onEnter) onEnter();
              else (e.target as HTMLInputElement).blur();
            }
          }}
          disabled={disabled}
          spellCheck={false}
          placeholder={placeholder}
          className="min-w-0 flex-1 bg-black/40 border border-white/10 rounded px-2 py-1.5 text-[10px] font-mono text-zinc-200 focus:border-purple-500/50 focus:outline-none disabled:opacity-50"
        />
        <button
          type="button"
          onClick={() => void browse()}
          disabled={disabled || picking}
          aria-label={buttonLabel}
          title={buttonLabel}
          className="shrink-0 inline-flex items-center justify-center gap-1.5 rounded border border-white/10 bg-white/5 px-2.5 py-1.5 text-[9px] font-black uppercase tracking-widest text-zinc-300 hover:border-purple-400/40 hover:bg-purple-500/15 hover:text-purple-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {picking ? <Loader2 className="w-3 h-3 animate-spin" /> : kind === 'folder' ? <FolderOpen className="w-3 h-3" /> : <FileSearch className="w-3 h-3" />}
          Browse
        </button>
      </div>
      {description && !descAsHover && <p className="text-[8px] text-zinc-600 leading-relaxed">{description}</p>}
      {error && <p className="w-full text-[8px] text-red-300 leading-relaxed">{error}</p>}
    </div>
  );
};