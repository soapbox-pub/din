import { useSeoMeta } from '@unhead/react';
import { Desktop } from '@/components/desktop/Desktop';
import { BootVeil } from '@/components/desktop/BootVeil';
import { MonitorsProvider } from '@/components/desktop/MonitorsProvider';

const Index = () => {
  useSeoMeta({
    title: 'Din',
    description: 'A web-native desktop environment built in Electron.',
  });

  return (
    <MonitorsProvider>
      <Desktop />
      <BootVeil />
    </MonitorsProvider>
  );
};

export default Index;
