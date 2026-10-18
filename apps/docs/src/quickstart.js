const code = (text, language = 'typescript') => ({ code: text, language });

export const quickstart = {
  id: 'quickstart', group: 'START HERE', title: 'Quickstart', eyebrow: 'ADD PILOT TO YOUR APP',
  description: 'Install Pilot in an existing app, connect a wallet, and add the permission modal and automatic signing. Pilot manages wallet-backed usernames.',
  sections: [
    {
      id: 'choose-packages', title: '1. What the installer adds',
      html: '<p>Use Node.js 22 or newer. Install Pilot from the <a href="https://github.com/Birdmannn/owl" target="_blank" rel="noopener">GitHub repository</a>: run the installer from your existing app to clone, build, and add Pilot as a local dependency. <strong>No npm or GitHub Packages publication is required.</strong></p>',
      table: [
        ['@owl/pilot', 'The SDK: session engine, counter connector, username helpers, and CKB/Spore transaction builders. Use it with any JavaScript framework.'],
        ['@owl/pilot-react', 'React 19 permission modal and stylesheet, installed automatically with the SDK for the Pilot connection flow.'],
        ['@ckb-ccc/connector-react', 'Wallet discovery and connection for the React example below. Pilot wraps the connected owner signer.'],
      ],
    },
    {
      id: 'build-packages', title: '2. Run the installer in your app',
      html: '<p>Open a terminal in your existing npm app, then run this command. You need Node.js 22+, npm, Git, and curl. The installer clones Pilot into a sibling <code>pilot</code> directory if needed, installs its build dependencies, builds the SDK and React modal, and adds them to your app. <strong>No package publication is required.</strong></p><p>The React 19 modal and wallet connector are included automatically. The installer rejects an existing incompatible React dependency or CCC override before changing your app. It uses npm; apps using another package manager need a manual installation.</p>',
      ...code('curl -fsSL https://raw.githubusercontent.com/Birdmannn/owl/main/scripts/install-pilot.mjs | node --input-type=module -', 'terminal'),
    },
    {
      id: 'install-in-your-app', title: 'Already cloned Pilot?',
      html: '<p>Run the same installer from your app using the checkout’s script. Replace the path if your checkout is somewhere else. Add <code>--source /path/to/pilot</code> to the downloaded installer to use a different checkout. Use <code>--help</code> to see the options.</p><p>The script pins CCC core to <code>1.23.0</code> for matching signer classes and writes <code>install-links=true</code> to your app’s <code>.npmrc</code>. It installs built copies as local <code>file:</code> dependencies, so keep the checkout available for future dependency installs.</p>',
      ...code('node ../pilot/scripts/install-pilot.mjs', 'terminal'),
    },
    {
      id: 'connect-wallet', title: '3. Connect the owner wallet',
      html: '<p>For React + Vite, use the following as <code>src/App.tsx</code> in your app. It connects an existing owner wallet through CCC and displays its CKB testnet address. Pilot manages usernames in its profile flow; app developers do not configure username storage here.</p><p>Connecting a wallet alone does not grant automatic signing permission. Add the Pilot modal and session flow in the next step.</p>',
      ...code(`import type { ReactNode } from 'react';
import { ccc } from '@ckb-ccc/connector-react';
import { PilotAccountsProvider, PilotAccountMenu, usePilotAccounts } from '@owl/pilot-react';
import '@owl/pilot-react/styles.css';

const client = new ccc.ClientPublicTestnet();

function AccountBridge({ children }: { children: ReactNode }) {
  const wallet = ccc.useCcc();
  const connect = () => {
    const show = () => {
      wallet.open();
      requestAnimationFrame(() => wallet.open());
    };
    if (wallet.signerInfo) {
      wallet.disconnect();
      setTimeout(show, 200); // Allow CCC to finish closing its old connection.
    } else show();
  };
  return <PilotAccountsProvider network="ckb-testnet"
    signer={wallet.signerInfo?.signer} walletName={wallet.wallet?.name}
    connectorOpen={wallet.isOpen} onConnectWallet={connect}
    onDisconnectWallet={wallet.disconnect}
    connectJoyId={async () => {
      const signer = new ccc.JoyId.CkbSigner(client, 'My app',
        new URL('/owl.png', location.origin).href, undefined, undefined,
        { get: async () => undefined, set: async () => {} });
      await signer.connect(); // Always open fresh JoyID authentication.
      return signer;
    }}>
    {children}
  </PilotAccountsProvider>;
}

function PilotAccount() {
  const { signer, accounts, currentId, connectWallet, disconnect, switching } = usePilotAccounts();
  return <section>
    <h1>Pilot in my app</h1>
    <PilotAccountMenu />
    <p>{accounts.find(account => account.id === currentId)?.address}</p>
    <button disabled={switching}
      onClick={signer ? disconnect : connectWallet}>
      {signer ? 'Disconnect' : 'Connect wallet'}
    </button>
  </section>;
}

export default function App() {
  return <ccc.Provider name="My app" defaultClient={client}>
    <AccountBridge><PilotAccount /></AccountBridge>
  </ccc.Provider>;
}`, 'tsx'),
    },
    {
      id: 'add-pilot-modal', title: '4. Add the Pilot modal and automatic signing',
      html: '<p>Import the installed UI package and its stylesheet in your React app. Place an <code>owl.png</code> brand image in your app’s public assets; the current modal reads it from <code>/owl.png</code>. You can copy the demo’s public owl asset from your Pilot checkout.</p><p><code>PilotModal</code> is a controlled component: your app provides the manifest, account, username, session state, and callbacks. For multiple accounts, wrap the modal with <code>PilotAccountsProvider</code> and use <code>usePilotAccounts()</code> as the active signer source; the demo’s <code>AccountBridge</code> shows CCC and fresh JoyID authentication wiring. See <a href="#wallet-flow/account-switching">account switching</a>. The <a href="#integration">connector and modal guide</a> explains the integration responsibilities; <code>apps/demo/src/main.tsx</code> and <code>apps/demo/src/runtime.ts</code> in the checkout contain the complete working counter-session wiring.</p>',
      ...code("import { PilotModal } from '@owl/pilot-react';\nimport '@owl/pilot-react/styles.css';"),
      table: [
        ['Owner connection', 'Use the signer from usePilotAccounts(). Pilot checks the selected account while the existing wallet keeps ownership.'],
        ['Username', 'Use PilotUsernameClient.findByAddress() or register() in the modal’s onProfile callback.'],
        ['App manifest', 'Use the legacy counter manifest or define named actions and builders with a version-2 delegation manifest. See Cell delegation.'],
        ['Session approval', 'Generate and persist a session key, then call PilotCounterConnector.authorize() with the user’s selected permission. Persist submitted setup before awaiting confirmation.'],
        ['Instant app actions', 'Create CkbCounterAdapter and Pilot with durable stores, check the grant, prepare possible actions, and render pilot.state after execute(). Settlement runs in the background.'],
      ],
    },
    {
      id: 'update-github-install', title: 'Update your GitHub installation',
      html: '<p>The installer rebuilds the current checkout; it does not pull changes automatically. Pull the revision you want, then re-run it from your app. The SDK, React modal, and wallet connector are always installed together.</p><p>For repeatable builds, check out a specific release tag or commit instead of pulling the latest branch. Commit your app’s lockfile and <code>.npmrc</code>. In CI, restore the Pilot checkout at the same path and revision, build it before running <code>npm ci</code> in your app. The installer installs dependencies only; wire the SDK and modal using the steps above.</p>',
      ...code('git -C ../pilot pull && node ../pilot/scripts/install-pilot.mjs', 'terminal'),
    },
    {
      id: 'supported-scope', title: 'What you can integrate today',
      html: '<p>The SDK’s username lookup and CKB/Spore builders can be used by other apps today. The public testnet flight uses <code>counter-v1</code>. The new <a href="#cell-delegation">developer delegation API</a> supports named builders, selected subsets, and creation/migration under a reusable bounded-u64 policy verified on local CKB. Another app’s arbitrary contract actions need a compatible on-chain policy and adapter; installing the package alone does not add that authority.</p><p>For a complete interactive example of the current policy, open the testnet demo. It uses the same SDK and React modal packages you installed above.</p>',
      demo: true,
    },
  ],
};
