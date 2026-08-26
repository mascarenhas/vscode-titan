#ifndef VSCODE_TITAN_COMPILER_IO_CLOCK_H
#define VSCODE_TITAN_COMPILER_IO_CLOCK_H

/* Keep platform headers out of Titan's generated translation unit: their
 * feature-test macros have to precede every system header. The separately
 * compiled implementation supplies this one narrow, typed boundary. A
 * negative result means that the platform clock could not be sampled. */
double vscode_titan_monotonic_ms(void);

#endif
