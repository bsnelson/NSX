// Seed data for the mock gateway. Mutated in-process by the mock's write
// endpoints so a dev session behaves like a real one (create a recipe, hide a
// profile, rate a shot — it all sticks until the server restarts).

export const machineState = { state: "idle", substate: "ready" };

export const machineInfo = {
  name: "Mock DE1",
  version: "1.6.0",
  serial: "MOCK-0001",
};

export const waterLevels = { currentLevel: 780, refillLevel: 100 };

const step = (temperature, seconds, pressure) => ({
  name: `Step ${temperature}`,
  temperature,
  seconds,
  pressure,
  pump: "pressure",
});

export const profiles = [
  {
    id: "profile:mock-default",
    isDefault: true,
    metadata: { source: "stock" },
    profile: {
      title: "Classic Italian espresso",
      author: "Decent",
      beverage_type: "espresso",
      steps: [step(92, 10, 3), step(92, 20, 9)],
    },
  },
  {
    id: "profile:mock-user",
    metadata: { source: "user" },
    profile: {
      title: "My Blooming Espresso",
      author: "You",
      version: 2,
      beverage_type: "espresso",
      steps: [step(93, 8, 2), step(93, 5, 0), step(92, 22, 8)],
    },
  },
  // Deliberately hidden — exercises the hidden-profile push path (the bug that
  // motivated resolving pushes against the visible+hidden set).
  {
    id: "profile:mock-hidden",
    visibility: "hidden",
    metadata: { source: "user" },
    profile: {
      title: "Hidden Turbo",
      author: "You",
      beverage_type: "espresso",
      steps: [step(90, 6, 6), step(90, 18, 6)],
    },
  },
  {
    id: "profile:mock-cleaning",
    metadata: { source: "user" },
    profile: {
      title: "Cleaning/Forward Flush x5",
      beverage_type: "cleaning",
      steps: [step(90, 5, 8), step(90, 5, 0), step(90, 5, 8), step(90, 5, 0), step(90, 5, 8)],
    },
  },
];

export const deletedProfiles = [];

export const beans = [
  {
    id: "bean-1",
    roaster: "Mock Roasters",
    name: "Yirgacheffe",
    roastDate: "2026-06-20",
    archived: false,
  },
];

export const beanBatches = {
  "bean-1": [{ id: "batch-1", beanId: "bean-1", roastDate: "2026-06-20", archived: false }],
};

export const grinders = [
  { id: "grinder-1", model: "Niche Zero", settingType: "stepless" },
  { id: "grinder-2", model: "DF64", settingType: "stepless" },
];

const shot = (id, minutesAgo, enjoyment) => {
  const start = new Date(Date.now() - minutesAgo * 60_000).toISOString();
  const n = 40;
  return {
    id,
    startTime: start,
    timestamp: start,
    annotations: { enjoyment, espressoNotes: null, extras: { favorite: false, tags: [] } },
    workflow: {
      profile: { title: "My Blooming Espresso", steps: [] },
      context: {
        coffeeRoaster: "Mock Roasters",
        coffeeName: "Yirgacheffe",
        grinderModel: "Niche Zero",
        grinderSetting: "18",
        targetDoseWeight: 18,
        targetYield: 36,
      },
    },
    measurements: Array.from({ length: n }, (_, i) => ({
      elapsed: i * 0.8,
      pressure: i < 6 ? i : 9 - i * 0.05,
      flow: i < 6 ? 0.4 : 2.1,
      groupTemperature: 92,
      targetGroupTemperature: 93,
      weight: i * 0.9,
    })),
  };
};

export const shots = [shot("shot-1", 20, 4), shot("shot-2", 90, 5), shot("shot-3", 300, 3)];

// Key-value store, namespaced. Matches the real gateway's shape:
// GET /store/<ns>?full=1 returns this dict for <ns>.
export const store = {
  NSX: {
    recipes: [
      {
        id: "recipe-mock-1",
        lastUsed: Date.now() - 60_000,
        coffeeRoaster: "Mock Roasters",
        coffeeName: "Yirgacheffe",
        grinderModel: "Niche Zero",
        grinderSetting: "18",
        profileTitle: "My Blooming Espresso",
        selectedProfileId: "profile:mock-user",
        targetDoseWeight: 18,
        targetYield: 36,
        groupTemp: 93,
      },
      {
        id: "recipe-mock-hidden",
        lastUsed: Date.now() - 3_600_000,
        coffeeRoaster: "Mock Roasters",
        coffeeName: "Turbo Blend",
        grinderModel: "DF64",
        grinderSetting: "3.2",
        profileTitle: "Hidden Turbo",
        selectedProfileId: "profile:mock-hidden",
        targetDoseWeight: 20,
        targetYield: 50,
        groupTemp: 90,
      },
    ],
    "ui-settings": {},
  },
  skin: { theme: "dark", lang: "de" },
};

export const currentWorkflow = {
  profile: profiles[1].profile,
  profileId: profiles[1].id,
  context: store.NSX.recipes[0],
};
