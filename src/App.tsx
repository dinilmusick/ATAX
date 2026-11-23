import React, { useState } from 'react';
import { BookOpen, Cpu, GitBranch, RefreshCw, Settings } from 'lucide-react';
import type { ActiveTab } from './types/substrate';
import { IconButton } from './components/IconButton';
import { SystemsGraphView } from './components/SystemsGraphView';
import { VisionsGoalsGraphView } from './components/VisionsGoalsGraphView';
import { SkillCatalogView } from './components/SkillCatalogView';
import { SettingsView } from './components/SettingsView';

function HayateCrest() {
  return (
    <svg
      viewBox="0 0 32 32"
      className="w-6 h-6 text-[#DFE4D8]"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M6 25L12 11L16 17L21 8L26 25H6Z"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinejoin="miter"
      />
      <circle cx="21" cy="8" r="2.2" fill="#C83214" />
    </svg>
  );
}

export default function App() {
  const [activeTab, setActiveTab] = useState<ActiveTab>('visions-goals');
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [operatorSession, setOperatorSession] = useState<{
    token: string;
    subject: string;
    expiresAt: number;
  } | null>(null);

  const handleRefresh = () => {
    setIsRefreshing(true);
    setTimeout(() => setIsRefreshing(false), 450);
  };

  return (
    <div className="min-h-screen bg-[#140D0B] text-[#F2EBE1] flex flex-col">
      {/* Top Bar: Wordmark — Icon-Only Tab Navigation — Icon-Only Primary Action */}
      <header className="border-b border-[#382821] bg-[#1A110E] sticky top-0 z-40">
        <div className="max-w-[1440px] mx-auto px-6 h-16 flex items-center justify-between gap-8">
          <div className="flex items-center gap-3 shrink-0">
            <HayateCrest />
            <span className="font-display text-lg font-bold tracking-[0.14em] uppercase text-[#F7F3EC] whitespace-nowrap">
              ATAX
            </span>
          </div>

          <nav aria-label="Primary Substrate Views" className="flex items-center gap-2">
            <IconButton
              label="Systems"
              active={activeTab === 'systems'}
              variant="accent"
              onClick={() => setActiveTab('systems')}
            >
              <Cpu className="w-4 h-4" />
            </IconButton>

            <IconButton
              label="Visions & Goals"
              active={activeTab === 'visions-goals'}
              variant="accent"
              onClick={() => setActiveTab('visions-goals')}
            >
              <GitBranch className="w-4 h-4" />
            </IconButton>

            <IconButton
              label="Skill Catalog"
              active={activeTab === 'skills'}
              variant="accent"
              onClick={() => setActiveTab('skills')}
            >
              <BookOpen className="w-4 h-4" />
            </IconButton>

            <IconButton
              label="Vault & Environment Settings"
              active={activeTab === 'settings'}
              variant="accent"
              onClick={() => setActiveTab('settings')}
            >
              <Settings className="w-4 h-4" />
            </IconButton>
          </nav>

          <div className="flex items-center shrink-0">
            <IconButton
              label="Refresh Substrate"
              tooltipSide="left"
              onClick={handleRefresh}
            >
              <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin text-[#E04819]' : ''}`} />
            </IconButton>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 max-w-[1440px] w-full mx-auto px-6 py-5 flex flex-col">
        {activeTab === 'systems' && <SystemsGraphView />}
        {activeTab === 'visions-goals' && <VisionsGoalsGraphView />}
        {activeTab === 'skills' && <SkillCatalogView />}
        {activeTab === 'settings' && (
          <SettingsView session={operatorSession} onSessionChange={setOperatorSession} />
        )}
      </main>
    </div>
  );
}
