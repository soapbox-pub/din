import { useSeoMeta } from '@unhead/react';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { LoginScreen } from '@/components/desktop/LoginScreen';
import { Desktop } from '@/components/desktop/Desktop';

const Index = () => {
  const { user } = useCurrentUser();

  useSeoMeta({
    title: 'Din',
    description: 'A web-native desktop environment built in Electron.',
  });

  return user ? <Desktop /> : <LoginScreen />;
};

export default Index;
