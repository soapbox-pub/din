import { useSeoMeta } from '@unhead/react';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { LoginScreen } from '@/components/desktop/LoginScreen';
import { Desktop } from '@/components/desktop/Desktop';
import { BootVeil } from '@/components/desktop/BootVeil';
import { MonitorsProvider } from '@/components/desktop/MonitorsProvider';

const Index = () => {
  const { user } = useCurrentUser();

  useSeoMeta({
    title: 'Din',
    description: 'A web-native desktop environment built in Electron.',
  });

  return (
    <MonitorsProvider>
      {user ? <Desktop /> : <LoginScreen />}
      <BootVeil />
    </MonitorsProvider>
  );
};

export default Index;
