import { avatarDef, AVATARS, randomAvatar } from './avatar';

describe('AVATARS', () => {
  // The server's avatarIDs (Server/internal/api/avatars.go) must list exactly these, in this order.
  it('lists the 24 ids of the contract in order', () => {
    expect(AVATARS.map(avatar => avatar.id)).toEqual([
      'rat', 'ox', 'tiger', 'rabbit', 'cat', 'dragon', 'snake', 'horse', 'goat', 'monkey', 'rooster', 'dog',
      'pig', 'panda', 'fox', 'frog', 'koala', 'lion', 'bear', 'penguin', 'owl', 'unicorn', 'octopus', 'turtle',
    ]);
  });

  it('gives each one its emoji and Vietnamese name', () => {
    expect(AVATARS.map(avatar => `${avatar.emoji} ${avatar.name}`)).toEqual([
      '🐭 Chuột', '🐮 Bò', '🐯 Hổ', '🐰 Thỏ', '🐱 Mèo', '🐲 Rồng', '🐍 Rắn', '🐴 Ngựa', '🐐 Dê', '🐵 Khỉ', '🐔 Gà', '🐶 Chó',
      '🐷 Heo', '🐼 Gấu trúc', '🦊 Cáo', '🐸 Ếch', '🐨 Gấu túi', '🦁 Sư tử', '🐻 Gấu', '🐧 Chim cánh cụt', '🦉 Cú',
      '🦄 Kỳ lân', '🐙 Bạch tuộc', '🐢 Rùa',
    ]);
  });

  it('has unique ids and a colour on each, cycling through a handful of tones', () => {
    expect(new Set(AVATARS.map(avatar => avatar.id)).size).toBe(24);
    for (const avatar of AVATARS) {
      expect(avatar.color).toMatch(/^#[0-9a-f]{6}$/i);
    }
    const tones = new Set(AVATARS.map(avatar => avatar.color));
    expect(tones.size).toBe(8);
    expect(AVATARS[8].color).toBe(AVATARS[0].color);
    expect(AVATARS[1].color).not.toBe(AVATARS[0].color);
  });
});

describe('avatarDef', () => {
  it('finds an avatar by id', () => {
    expect(avatarDef('fox')).toBe(AVATARS[14]);
  });

  it('is undefined for an empty, unknown or missing id', () => {
    expect(avatarDef('')).toBeUndefined();
    expect(avatarDef('dodo')).toBeUndefined();
    expect(avatarDef(null)).toBeUndefined();
    expect(avatarDef(undefined)).toBeUndefined();
  });
});

describe('randomAvatar', () => {
  it('picks the avatar the random number points at', () => {
    expect(randomAvatar(() => 0)).toBe('rat');
    expect(randomAvatar(() => 0.5)).toBe(AVATARS[12].id);
    expect(randomAvatar(() => 0.999999)).toBe('turtle');
  });

  it('stays in the set even when the generator returns 1', () => {
    expect(randomAvatar(() => 1)).toBe('turtle');
  });

  it('never returns the avatar to avoid, whatever the random number', () => {
    for (const except of AVATARS.map(avatar => avatar.id)) {
      for (let i = 0; i < 100; i++) {
        expect(randomAvatar(() => i / 100, except)).not.toBe(except);
      }
    }
  });

  it('skips over the avatar to avoid, so the others keep their turn', () => {
    expect(randomAvatar(() => 0, 'rat')).toBe('ox');
    expect(randomAvatar(() => 0.999999, 'turtle')).toBe('octopus');
  });

  it('ignores an except that is not in the set', () => {
    expect(randomAvatar(() => 0, 'dodo')).toBe('rat');
    expect(randomAvatar(() => 0, '')).toBe('rat');
  });

  it('uses Math.random by default', () => {
    spyOn(Math, 'random').and.returnValue(0);
    expect(randomAvatar()).toBe('rat');
  });
});
