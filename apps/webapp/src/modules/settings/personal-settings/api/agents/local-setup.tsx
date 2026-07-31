import { InstallConfig } from './install-config';

/**
 * How to connect a harness on your own machine, readable before you have made
 * an agent.
 *
 * This existed before as a greyed-out block under the words "generate a token
 * above to fill these in", stapled to the create form — inert, and reading as
 * something broken rather than as instructions. Removing it went too far the
 * other way: whether to set an agent up at all is a question you answer by
 * reading what setting one up involves, and that has to be available before
 * anything is created.
 *
 * So it is neither a preview nor an afterthought: its own section, at full
 * strength, with a placeholder where the token goes. The surrounding
 * `SettingSection` already says the token arrives when you create an agent, so
 * nothing here has to apologise for not having one.
 *
 * And when one has just been created, this is where it lands. The create form
 * used to render its own copy of all of this with the real token in it, so the
 * page carried the instructions twice; the token now comes down here instead,
 * which leaves one set of steps that is simply live while the value exists.
 */
export function LocalSetup({ token }: { token?: string }) {
  return <InstallConfig token={token} />;
}
