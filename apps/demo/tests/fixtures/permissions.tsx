import { createRoot } from 'react-dom/client';
import { PilotModal, PilotOffchainModal } from '@owl/pilot-react';
import { DELEGATION_V1_CODE_HASH, type PilotAppManifest } from '@owl/pilot';

/** Browser-only consent fixture: no signer, RPC, funding or transaction submission. */
export function mountPermissions(kind: 'chain' | 'offchain') {
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  const record = (selected: string[]) => {
    let output = document.querySelector<HTMLOutputElement>('[data-testid="permission-result"]');
    if (!output) { output = document.createElement('output'); output.hidden = true; output.dataset.testid = 'permission-result'; document.body.append(output); }
    output.textContent = JSON.stringify(selected);
  };
  const actions = Array.from({ length: 50 }, (_, i) => ({ id: `app.action${i}`, name: `Action ${i}`, description: `Permission number ${i}` }));
  const close = () => root.unmount();
  if (kind === 'offchain') {
    root.render(<PilotOffchainModal visible manifest={{ appId: 'catalog-test', name: 'Catalog test', audience: location.origin, actions }} address="ckt1-test-owner" busy={false} onClose={close} onConnectOwner={() => {}} onAuthorize={async selected => { record(selected); }} />);
    return;
  }
  const manifest: PilotAppManifest = {
    version: 2, app: { id: 'catalog-test', name: 'Catalog test', description: 'Choose from 50 actions' }, network: 'ckb-testnet',
    actions: actions.map((a, i) => ({ ...a, operation: a.id, delegation: i === 49 ? 'owner-only' : 'allowed', transition: { kind: 'u64-increment', offset: 0, delta: '1' } })),
    policy: {
      kind: 'delegation-v1',
      deployment: { network: 'testnet', codeHash: DELEGATION_V1_CODE_HASH, genesisHash: `0x${'00'.repeat(32)}`, outPoint: { txHash: `0x${'01'.repeat(32)}`, index: 0 } },
      feePerAction: '100000', budget: '2000000', floorCapacity: '35000000000', maxSetupFee: '1000000', maxRecoveryFee: '1000000',
    },
  };
  root.render(<PilotModal manifest={manifest} visible address="ckt1-test-owner" profile={{ username: 'test_pilot' }} active={false} busy="" canAuthorize queueLength={0} submitted={false} error=""
    onResume={async () => {}} onClose={close} onConnectOwner={() => {}} onProfile={async username => ({ username })} onAuthorize={async selected => { record(selected); return true; }}
    onDisconnect={close} onRevoke={async () => {}} onRefreshBalance={() => {}} />);
}
