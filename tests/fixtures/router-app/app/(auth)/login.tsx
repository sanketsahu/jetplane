// Representative AI-generated login screen (public group).
import { useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '../../src/hooks';

export default function LoginScreen() {
  const { signIn } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  return (
    <SafeAreaView className="flex-1 justify-center bg-background px-6">
      <Text testID="login-title" className="mb-6 text-2xl font-bold text-foreground">
        Sign in
      </Text>
      <TextInput
        className="mb-3 rounded-lg border border-border px-4 py-3 text-foreground"
        placeholder="Email"
        autoCapitalize="none"
        keyboardType="email-address"
        value={email}
        onChangeText={setEmail}
      />
      <TextInput
        className="mb-6 rounded-lg border border-border px-4 py-3 text-foreground"
        placeholder="Password"
        secureTextEntry
        value={password}
        onChangeText={setPassword}
      />
      <Pressable
        className="items-center rounded-lg bg-primary py-3"
        onPress={() => signIn.mutate({ email, password })}
        disabled={signIn.isPending}
      >
        <Text className="font-semibold text-primary-foreground">
          {signIn.isPending ? 'Signing in…' : 'Sign in'}
        </Text>
      </Pressable>
    </SafeAreaView>
  );
}
