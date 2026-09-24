// Narrative copy for the guided "Exploratory" tutorial (welcome/about text,
// the constellation-matching game's messages, and the scripted star/cluster
// tours) — pure data, no logic. Kept separate from index.html so the app
// code isn't interleaved with prose, and so the copy can be edited without
// touching anything that runs.

export const WELCOME_MESSAGE = "Welcome to the vicinity of the Sun. Switch to exploratory mode to study the mechanics of the model or navigate between stars in free mode.";
export const FEEDBACK_MESSAGE = "Your feedback is always welcome: jeffrey3829@proton.me";
export const ABOUT_MESSAGE = "Stars brightness and size not to scale. Do not consider as a source of reliable data. Please use Chrome for a better experience. This model has made use of the SIMBAD database, CDS, Strasbourg Astronomical Observatory, France.";

export const CONS_STAGE = "Looks like some constellations names are misplaced. Will you be able to find pairs of incorrectly named constellations? Click the constellations names which are out of place.";
export const CONS_HIT = "Well done! Let's put them in their place.";
export const CONS_MISS = "No, these two are in place.";
export const CONS_PART_MISS = "One of these two is misplaced. Take a closer look.";
export const CONS_COMPLETED = "Hooray! Now all constellations are in place. The setting to hide/show constellations is available now.";

export const STARS_STAGE = "Let's find the most interesting neighboring stars. Use 'Fly to Sun' if you got lost. ";
// STARS_TO_VISIT (SIMBAD ids), STARS_INSTRUCTIONS and STARS_INFO are
// parallel arrays — index i in one names/describes the same star as index i
// in the others.
export const STARS_TO_VISIT = [
  "* alf CMa",
  "* alf Lyr",
  "* alf PsA",
  "* alf Tau",
  "* alf Boo",
];
export const STARS_INSTRUCTIONS = [
  "The first stop is Sirius (Alpha CANIS MAJOR)",
  "The next stop is Vega (Alpha LYRA)",
  "Would you like to see Fomalhaut? (Alpha PISCIS AUSTRINUS)",
  "Why not visit Aldebaran? (Alpha TAURUS)",
  "The last destination is Arcturus (Alpha BOOTES)",
];
export const STARS_INFO = [
  "Sirius is the brightest star in the night sky. It's a binary star consisting of a main-sequence star Sirius A, and a faint white dwarf Sirius B.",
  "Vega is the fifth-brightest star in the night sky and is only about a tenth of the age of the Sun.",
  "Fomalhaut is a class A star on the main sequence approximately 25 light-years from the Sun.",
  "Aldebaran is a red giant with a surface temperature of 3,900 K, it is over 400 times as luminous as the Sun.",
  "Arcturus is a red giant of spectral type K, an aging star around 7.1 billion years old.",
];

export const CLUSTERS_STAGE = "Looks like it's time to visit nearest star clusters. Move with WASD. Use mouse panning to correct the direction and the compas to navigate.";
// The 5 clusters to visit are picked at random from files/clusters.txt and
// sorted nearest-first; their "Well done" blurb is the 4th field in that file.
export const CLUSTER_ORDINALS = ["first", "second", "third", "fourth", "last"];

export const MODE_COMPLETED = "Exploratory mode completed. Search by star name is available now. You can also use density setting to find interesting areas in Sun surroundings or you can travel to the center of the galaxy and observe the movement of nearby stars.";
