// Representative AI-generated home screen — the fixture's stand-in for what
// RapidNative generates on top of the scaffold (scaffold ships layouts only).
import { useCallback } from 'react';
import { FlatList, Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '../../src/hooks';

const ITEMS = [
  { id: '1', title: 'First item' },
  { id: '2', title: 'Second item' },
  { id: '3', title: 'Third item' },
];

export default function HomeScreen() {
  const { user, signOut } = useAuth();

  const renderItem = useCallback(
    ({ item }: { item: (typeof ITEMS)[number] }) => (
      <View className="border-b border-border px-4 py-3">
        <Text className="text-foreground">{item.title}</Text>
      </View>
    ),
    []
  );

  return (
    <SafeAreaView className="flex-1 bg-background">
      <View className="flex-row items-center justify-between px-4 py-3">
        <Text testID="home-title" className="text-xl font-bold text-foreground">
          Welcome home
        </Text>
        <Pressable onPress={() => signOut.mutate()}>
          <Text className="text-primary">Sign out</Text>
        </Pressable>
      </View>
      <Text className="px-4 pb-2 text-muted-foreground">{user?.email ?? 'anonymous'}</Text>
      <FlatList data={ITEMS} keyExtractor={(i) => i.id} renderItem={renderItem} />
    </SafeAreaView>
  );
}
