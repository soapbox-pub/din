import { useSeoMeta } from '@unhead/react';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { LoginScreen } from '@/components/desktop/LoginScreen';
import { Desktop } from '@/components/desktop/Desktop';

const Index = () => {
  const { user } = useCurrentUser();

  useSeoMeta({
    title: 'webOS demo',
    description: 'A minimal Linux system whose entire UI is a web app.',
  });

  return user ? <Desktop /> : <LoginScreen />;
};

export default Index;
