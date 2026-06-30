import React, { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { ChevronDown, GripHorizontal } from 'lucide-react';

interface SectionProps {
  title: string;
  icon?: any;
  rightNode?: React.ReactNode;
  defaultOpen?: boolean;
  children: React.ReactNode;
  resizable?: boolean;
  minHeight?: number;
  /** Cap the inner scroll area's height. Defaults to 800px to keep
   *  Sections in long pages compact. Pass `null` to disable — the
   *  Section grows to fit its content and lets the parent's scroll
   *  handle overflow (used by the Library panel to avoid a
   *  double-scroll inside the right rail). */
  maxContentHeight?: number | null;
  /** When false, the Section is always open and never shows a
   *  collapse chevron. Used for the LIBRARY section in the right
   *  rail, which already has the rail-level collapse button — the
   *  inner chevron was a confusing duplicate handle. */
  collapsible?: boolean;
  /** Fill the parent's remaining height instead of sizing to content.
   *  The header stays fixed at the top and the body becomes a bounded
   *  flex column (min-h-0) so a `flex-1 overflow-y-auto` child inside
   *  scrolls on its own — i.e. a sticky header with a scrolling body.
   *  Used by the LIBRARY panel. Implies non-resizable, no height
   *  animation. */
  fill?: boolean;
}

export const Section: React.FC<SectionProps> = ({
  title,
  icon: Icon,
  rightNode,
  defaultOpen = false,
  children,
  resizable = true,
  minHeight = 80,
  maxContentHeight = 800,
  collapsible = true,
  fill = false,
}) => {
  // Fill mode owns its own height via flex, so the drag-to-resize
  // handle is disabled.
  const canResize = fill ? false : resizable;
  // When collapsible=false the Section is locked open. defaultOpen
  // is ignored in that mode.
  const [isOpen, setIsOpen] = useState(collapsible ? defaultOpen : true);
  const [height, setHeight] = useState<number | string>('auto');
  const [isResizing, setIsResizing] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const newHeight = Math.max(minHeight, e.clientY - rect.top);
      setHeight(newHeight);
    };

    const handleMouseUp = () => setIsResizing(false);

    if (isResizing) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = 'row-resize';
    } else {
      document.body.style.cursor = 'default';
    }

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = 'default';
    };
  }, [isResizing, minHeight]);

  return (
    <div className={`hardware-card flex flex-col relative mb-1 last:mb-0 ${fill ? 'flex-1 min-h-0' : 'shrink-0'}`}>
       <div
         className={`flex items-center justify-between px-2 py-1.5 select-none bg-white/2 transition-colors shrink-0 ${
           collapsible ? 'cursor-pointer hover:bg-white/5' : ''
         }`}
         onClick={collapsible ? () => setIsOpen(!isOpen) : undefined}
       >
          <div className="flex items-center gap-2">
             {Icon && <Icon className="w-3.5 h-3.5 text-purple-400" />}
             <span className="mono-label text-[10px]!">{title}</span>
          </div>
          <div className="flex items-center gap-2">
             {rightNode}
             {collapsible && (
               <ChevronDown className={`w-3.5 h-3.5 text-zinc-500 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`} />
             )}
          </div>
       </div>
       <AnimatePresence>
         {isOpen && (
           <motion.div
             initial={fill ? { opacity: 0 } : { height: 0, opacity: 0 }}
             animate={fill ? { opacity: 1 } : { height: height === 'auto' ? 'auto' : height, opacity: 1 }}
             exit={fill ? { opacity: 0 } : { height: 0, opacity: 0 }}
             className={`overflow-hidden flex flex-col ${fill ? 'flex-1 min-h-0' : ''}`}
             ref={containerRef}
           >
              <div
                className={`flex flex-col gap-2 pt-2 border-t border-white/5 p-2 no-scrollbar overflow-x-hidden ${fill ? 'flex-1 min-h-0' : 'flex-1'} ${maxContentHeight !== null ? 'overflow-y-auto' : ''}`}
                style={maxContentHeight !== null ? { maxHeight: `${maxContentHeight}px` } : undefined}
              >
                {children}
              </div>
              {canResize && (
                <div 
                  className="h-1.5 cursor-row-resize hover:bg-purple-500/20 transition-colors flex items-center justify-center group relative mt-1"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    setIsResizing(true);
                  }}
                >
                  <div className="w-8 h-0.5 bg-zinc-800 rounded-full group-hover:bg-purple-500/50" />
                </div>
              )}
           </motion.div>
         )}
       </AnimatePresence>
    </div>
  );
};

