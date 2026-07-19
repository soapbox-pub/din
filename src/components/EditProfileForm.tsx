import { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Loader2, Upload } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useNostrPublish } from '@/hooks/useNostrPublish';
import { useToast } from '@/hooks/useToast';
import { useUploadFile } from '@/hooks/useUploadFile';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { getAvatarShape } from '@/lib/avatarShape';

/** The subset of kind-0 metadata this form manages directly. */
interface ProfileFields {
  name: string;
  about: string;
  picture: string;
  banner: string;
  nip05: string;
  website: string;
}

const EMPTY: ProfileFields = {
  name: '',
  about: '',
  picture: '',
  banner: '',
  nip05: '',
  website: '',
};

/**
 * Compact editor for the current user's Nostr profile (NIP-01 kind 0).
 *
 * Deliberately dependency-light — plain React state rather than
 * react-hook-form — so it stays buildable without extra packages. It merges
 * edits onto the existing metadata (so fields it doesn't expose are
 * preserved), publishes a fresh kind 0, and invalidates the profile caches so
 * the rest of the desktop reflects the change immediately.
 */
export function EditProfileForm({ onSaved }: { onSaved?: () => void }) {
  const queryClient = useQueryClient();
  const { user, metadata } = useCurrentUser();
  const { mutateAsync: publishEvent, isPending } = useNostrPublish();
  const { mutateAsync: uploadFile, isPending: isUploading } = useUploadFile();
  const { toast } = useToast();

  const [fields, setFields] = useState<ProfileFields>(EMPTY);

  // Seed the form from the current user's metadata once it's available, and
  // re-seed if the active account changes. Done during render (React's
  // recommended pattern for resetting state on an input change) rather than in
  // an effect, so it never clobbers in-progress edits on a background refetch.
  const [seededFor, setSeededFor] = useState<string | null>(null);
  if (user && metadata && seededFor !== user.pubkey) {
    setSeededFor(user.pubkey);
    setFields({
      name: metadata.name ?? '',
      about: metadata.about ?? '',
      picture: metadata.picture ?? '',
      banner: metadata.banner ?? '',
      nip05: metadata.nip05 ?? '',
      website: metadata.website ?? '',
    });
  }

  const set =
    (key: keyof ProfileFields) =>
    (value: string) =>
      setFields((prev) => ({ ...prev, [key]: value }));

  const upload = async (file: File, field: 'picture' | 'banner') => {
    try {
      // useUploadFile returns NIP-94 imeta tags; the first tag's value is the URL.
      const [[, url]] = await uploadFile(file);
      set(field)(url);
    } catch (error) {
      console.error(`Failed to upload ${field}:`, error);
      toast({
        title: 'Upload failed',
        description: `Could not upload your ${field === 'picture' ? 'picture' : 'banner'}.`,
        variant: 'destructive',
      });
    }
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!user) {
      toast({
        title: 'Not signed in',
        description: 'Sign in to edit your profile.',
        variant: 'destructive',
      });
      return;
    }

    // Merge onto existing metadata so untouched fields survive; empty inputs
    // clear their key rather than publishing an empty string.
    const data: Record<string, unknown> = { ...metadata };
    for (const [key, value] of Object.entries(fields)) {
      const trimmed = value.trim();
      if (trimmed) data[key] = trimmed;
      else delete data[key];
    }

    try {
      await publishEvent({ kind: 0, content: JSON.stringify(data) });
      queryClient.invalidateQueries({ queryKey: ['nostr', 'logins'] });
      queryClient.invalidateQueries({ queryKey: ['nostr', 'author', user.pubkey] });
      toast({ title: 'Profile updated' });
      onSaved?.();
    } catch (error) {
      console.error('Failed to update profile:', error);
      toast({
        title: 'Update failed',
        description: 'Could not publish your profile. Please try again.',
        variant: 'destructive',
      });
    }
  };

  const busy = isPending || isUploading;

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div className="flex items-center gap-4">
        <Avatar className="size-16 shrink-0" shape={getAvatarShape(metadata)}>
          <AvatarImage src={fields.picture || undefined} alt="" />
          <AvatarFallback className="text-lg">
            {fields.name.charAt(0) || '?'}
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1 space-y-2">
          <Label htmlFor="profile-picture">Picture</Label>
          <div className="flex items-center gap-2">
            <Input
              id="profile-picture"
              placeholder="https://…"
              value={fields.picture}
              onChange={(e) => set('picture')(e.target.value)}
            />
            <UploadButton onFile={(file) => upload(file, 'picture')} />
          </div>
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="profile-banner">Banner</Label>
        <div className="flex items-center gap-2">
          <Input
            id="profile-banner"
            placeholder="https://…"
            value={fields.banner}
            onChange={(e) => set('banner')(e.target.value)}
          />
          <UploadButton onFile={(file) => upload(file, 'banner')} />
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="profile-name">Name</Label>
        <Input
          id="profile-name"
          placeholder="Your name"
          value={fields.name}
          onChange={(e) => set('name')(e.target.value)}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="profile-about">About</Label>
        <Textarea
          id="profile-about"
          placeholder="Tell people about yourself"
          className="resize-none"
          rows={3}
          value={fields.about}
          onChange={(e) => set('about')(e.target.value)}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="profile-nip05">NIP-05</Label>
          <Input
            id="profile-nip05"
            placeholder="you@example.com"
            value={fields.nip05}
            onChange={(e) => set('nip05')(e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="profile-website">Website</Label>
          <Input
            id="profile-website"
            placeholder="https://example.com"
            value={fields.website}
            onChange={(e) => set('website')(e.target.value)}
          />
        </div>
      </div>

      <div className="flex justify-end">
        <Button type="submit" disabled={busy}>
          {busy && <Loader2 className="animate-spin" aria-hidden />}
          Save profile
        </Button>
      </div>
    </form>
  );
}

/** Hidden file input fronted by an outline button, for image uploads. */
function UploadButton({ onFile }: { onFile: (file: File) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onFile(file);
          e.target.value = '';
        }}
      />
      <Button
        type="button"
        variant="outline"
        size="icon"
        className="shrink-0"
        aria-label="Upload image"
        title="Upload image"
        onClick={() => inputRef.current?.click()}
      >
        <Upload aria-hidden />
      </Button>
    </>
  );
}
