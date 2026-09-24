// ★ Word lists for identity generation — common given/surnames, no
// celebrity-only names, no project prefix. Company adj/noun lists are optional (return null when
// the upstream doesn't ask for a company name).

import { makeNames } from 'regkit/names';

export const WORDS = {
  first: [
    'emma', 'olivia', 'ava', 'sophia', 'isabella', 'mia', 'charlotte', 'amelia',
    'harper', 'evelyn', 'abigail', 'emily', 'elizabeth', 'ella', 'grace', 'hannah',
    'lily', 'aria', 'layla', 'nora', 'luna', 'nina', 'maya', 'kai', 'zoe', 'ella',
    'liam', 'noah', 'oliver', 'elijah', 'james', 'william', 'benjamin', 'lucas',
    'henry', 'alexander', 'mason', 'ethan', 'daniel', 'jack', 'samuel', 'logan',
    'owen', 'caleb', 'nathan', 'ryan', 'tristan', 'dylan', 'evan', 'isaac', 'julian',
  ],
  last: [
    'smith', 'johnson', 'williams', 'brown', 'jones', 'garcia', 'miller', 'davis',
    'rodriguez', 'martinez', 'wilson', 'anderson', 'thomas', 'taylor', 'moore',
    'jackson', 'martin', 'lee', 'thompson', 'white', 'harris', 'clark', 'lewis',
    'walker', 'young', 'allen', 'king', 'wright', 'scott', 'torres', 'nguyen',
    'hill', 'flores', 'green', 'adams', 'nelson', 'baker', 'hall', 'rivera',
    'campbell', 'mitchell', 'carter', 'roberts', 'phillips', 'evans', 'turner',
    'parker', 'edwards', 'collins', 'stewart', 'morris',
  ],
  adj: [
    'north', 'bright', 'clear', 'summit', 'harbor', 'cedar', 'delta', 'orbit',
    'vector', 'quartz', 'atlas', 'meridian', 'cobalt', 'juniper', 'lantern',
    'beacon', 'cascade', 'granite', 'harvest', 'ion',
  ],
  noun: [
    'labs', 'research', 'systems', 'works', 'group', 'studio', 'collective',
    'analytics', 'robotics', 'software', 'dynamics', 'ventures', 'tools',
  ],
};

export const names = makeNames(WORDS);
