import React, { useState } from 'react';
import { Trash2, Download, Upload, Clock, Music, FolderOpen } from 'lucide-react';
import type { RecordingEntry, NoteEvent, ScaleType, Genre } from './types';
import { NOTE_NAMES } from './constants';

interface RecordingHistoryProps {
  recordings: RecordingEntry[];
  onLoad: (recording: RecordingEntry) => void;
  onDelete: (id: string) => void;
  onClearAll: () => void;
  onExportAll: () => void;
  onImport: (recordings: RecordingEntry[]) => void;
}

export const RecordingHistory: React.FC<RecordingHistoryProps> = ({
  recordings,
  onLoad,
  onDelete,
  onClearAll,
  onExportAll,
  onImport
}) => {
  const [isExpanded, setIsExpanded] = useState(false);

  const formatDate = (timestamp: number) => {
    const date = new Date(timestamp);
    return date.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  const getKeyName = (rootNote: number, scale: ScaleType) => {
    return `${NOTE_NAMES[rootNote % 12]} ${scale}`;
  };

  const handleImportClick = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;

      try {
        const text = await file.text();
        const data = JSON.parse(text);

        // Validate it's an array of recordings
        if (Array.isArray(data) && data.every(r => r.id && r.notes && r.timestamp)) {
          onImport(data);
        } else if (data.id && data.notes && data.timestamp) {
          // Single recording
          onImport([data]);
        } else {
          alert('Invalid recording file format');
        }
      } catch (err) {
        alert('Failed to parse recording file');
      }
    };
    input.click();
  };

  if (recordings.length === 0 && !isExpanded) {
    return (
      <div className="bg-zinc-900 border border-white/10 rounded-xl p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Clock size={14} className="text-gray-500" />
            <span className="text-xs text-gray-400">Recording History</span>
          </div>
          <button
            onClick={handleImportClick}
            className="text-[10px] text-gray-500 hover:text-cyan-400 transition-colors flex items-center gap-1"
          >
            <Upload size={10} /> Import
          </button>
        </div>
        <p className="text-[10px] text-gray-600 mt-2">No recordings saved yet</p>
      </div>
    );
  }

  return (
    <div className="bg-zinc-900 border border-white/10 rounded-xl p-4">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="flex items-center gap-2 text-gray-400 hover:text-white transition-colors"
        >
          <Clock size={14} />
          <span className="text-xs font-medium">Recording History</span>
          <span className="text-[10px] text-cyan-400 bg-cyan-500/20 px-1.5 py-0.5 rounded">
            {recordings.length}
          </span>
        </button>

        <div className="flex items-center gap-2">
          <button
            onClick={handleImportClick}
            className="text-[10px] text-gray-500 hover:text-cyan-400 transition-colors"
            title="Import recordings"
          >
            <Upload size={12} />
          </button>
          {recordings.length > 0 && (
            <>
              <button
                onClick={onExportAll}
                className="text-[10px] text-gray-500 hover:text-emerald-400 transition-colors"
                title="Export all recordings"
              >
                <Download size={12} />
              </button>
              <button
                onClick={onClearAll}
                className="text-[10px] text-gray-500 hover:text-red-400 transition-colors"
                title="Clear all recordings"
              >
                <Trash2 size={12} />
              </button>
            </>
          )}
        </div>
      </div>

      {/* Recording List */}
      {isExpanded && (
        <div className="space-y-2 max-h-48 overflow-y-auto">
          {recordings.map((recording) => (
            <div
              key={recording.id}
              className="bg-black/30 border border-white/10 rounded-lg p-2 hover:border-gray-600 transition-colors group"
            >
              <div className="flex items-center justify-between">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <Music size={10} className="text-cyan-400 shrink-0" />
                    <span className="text-xs text-white truncate">{recording.name}</span>
                  </div>
                  <div className="flex items-center gap-2 mt-1 text-[9px] text-gray-500">
                    <span>{formatDate(recording.timestamp)}</span>
                    <span>|</span>
                    <span>{recording.notes.length} notes</span>
                    <span>|</span>
                    <span>{recording.bpm} BPM</span>
                    <span>|</span>
                    <span>{getKeyName(recording.rootNote, recording.scale)}</span>
                  </div>
                </div>

                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    onClick={() => onLoad(recording)}
                    className="p-1.5 text-gray-400 hover:text-cyan-400 hover:bg-cyan-500/10 rounded transition-colors"
                    title="Load recording"
                  >
                    <FolderOpen size={12} />
                  </button>
                  <button
                    onClick={() => onDelete(recording.id)}
                    className="p-1.5 text-gray-400 hover:text-red-400 hover:bg-red-500/10 rounded transition-colors"
                    title="Delete recording"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {!isExpanded && recordings.length > 0 && (
        <button
          onClick={() => setIsExpanded(true)}
          className="text-[10px] text-gray-500 hover:text-white transition-colors"
        >
          Click to expand ({recordings.length} recordings)
        </button>
      )}
    </div>
  );
};
