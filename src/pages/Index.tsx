import { useEffect, useState } from 'react';
import { useSeoMeta } from '@unhead/react';
import { Desktop } from '@/components/desktop/Desktop';
import { BootVeil } from '@/components/desktop/BootVeil';
import { MonitorsProvider } from '@/components/desktop/MonitorsProvider';
import { Setup } from '@/components/desktop/Setup';
import { getEraseBridge } from '@/lib/erase';

const Index = () => {
  useSeoMeta({
    title: 'Din',
    description: 'A web-native desktop environment built in Electron.',
  });

  // An erased DinOS computer gets its password before the desktop starts,
  // and with it anything that keeps what the user does. Unknown until asked.
  const [setup, setSetup] = useState<boolean | undefined>(() => (getEraseBridge() ? undefined : false));
  useEffect(() => {
    getEraseBridge()?.setupNeeded().then(setSetup, () => setSetup(false));
  }, []);

  return (
    <MonitorsProvider>
      {setup === false && <Desktop />}
      {setup && <Setup onDone={() => setSetup(false)} />}
      <BootVeil />
    </MonitorsProvider>
  );
};

export default Index;
