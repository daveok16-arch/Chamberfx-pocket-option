const fs = require('fs');
let code = fs.readFileSync('src/App.tsx', 'utf8');

// We want to safely replace the large chunks with our components.

// Let's replace the asset browser part.
const assetStartStr = `<AnimatePresence initial={false}>`;
const assetEndStr = `</AnimatePresence>`;

// It's safer to just replace lines directly since we know the exact lines from our previous view.
// Wait, I can use a script to slice lines and replace them.
const lines = code.split('\n');

// We'll replace 443-575 (0-indexed 442 to 574)
// and 577-644 (0-indexed 576 to 643)

// Wait, let's just make sure the lines contain what we expect before replacing.
if (lines[443].includes('<AnimatePresence initial={false}>') && lines[575].includes('</AnimatePresence>')) {
  const newAssetBrowser = `
                <AnimatePresence initial={false}>
                  {(!isAssetListCollapsed || window.innerWidth >= 1024) && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: "auto", opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.15 }}
                      className="bg-[#0D0F12] border border-[#1E2229] rounded-2xl p-4.5 flex flex-col gap-4 overflow-hidden shadow-xl"
                    >
                      <div className="flex items-center justify-between text-[10px] font-mono border-b border-[#1E2229]/60 pb-3">
                        <div className="flex items-center gap-1.5">
                          <span className="relative flex h-2 w-2">
                            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#00D084] opacity-75"></span>
                            <span className="relative inline-flex rounded-full h-2 w-2 bg-[#00D084]"></span>
                          </span>
                          <span className="text-zinc-400 uppercase tracking-widest font-bold">
                            Live Pocket Option Feed
                          </span>
                        </div>
                        <span className="text-zinc-500 font-bold bg-[#181C24] px-1.5 py-0.5 rounded text-[8.5px]">
                          OTC REALTIME
                        </span>
                      </div>
                      <AssetBrowser 
                        rankings={renderedAssetList}
                        selectedAssetId={selectedAssetId}
                        setSelectedAssetId={setSelectedAssetId}
                        minQualityScore={minQualityScore}
                        priceFlash={priceFlash}
                      />
                    </motion.div>
                  )}
                </AnimatePresence>
`;
  lines.splice(443, 575 - 443 + 1, newAssetBrowser);
}

// Write back so we can see
fs.writeFileSync('src/App.tsx', lines.join('\n'));
