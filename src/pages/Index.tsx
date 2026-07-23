import { useSeoMeta } from '@unhead/react';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { LoginScreen } from '@/components/desktop/LoginScreen';
import { Desktop } from '@/components/desktop/Desktop';
import { BootVeil } from '@/components/desktop/BootVeil';

const Index = () => {
  const { user } = useCurrentUser();

  useSeoMeta({
    title: 'Din',
    description: 'A web-native desktop environment built in Electron.',
  });

  return (
    <>
      {user ? <Desktop /> : <LoginScreen />}
      <BootVeil />
    </>
  );
};

export default Index;
