export interface CapabilitySectionLoad {
  section: string;
  load: () => Promise<object>;
}

/** Publish each settings inventory as soon as it is ready instead of waiting for the slowest section. */
export async function loadCapabilitySections(
  sections: readonly CapabilitySectionLoad[],
  onSettled: (section: string, inventory?: object) => void,
): Promise<string[]> {
  const results = await Promise.all(sections.map(async ({ section, load }) => {
    const outcome = await load().then(
      (inventory) => ({ ok: true as const, inventory }),
      () => ({ ok: false as const }),
    );
    if (outcome.ok) {
      onSettled(section, outcome.inventory);
      return undefined;
    }
    onSettled(section);
    return section;
  }));
  return results.filter((section): section is string => section !== undefined);
}
