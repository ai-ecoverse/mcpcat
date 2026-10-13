#!/usr/bin/env node

const args = process.argv.slice(2);

if (args[0] === '--mcp') {
  console.log(
    JSON.stringify({
      commands: [
        {
          name: 'echo',
          description: 'Echo the text argument',
          positionals: [{ name: 'text', required: true }],
          flags: [],
        },
        {
          name: 'upper',
          description: 'Uppercase the input',
          positionals: [{ name: 'text', required: true }],
          flags: [],
        },
      ],
    })
  );
  process.exit(0);
}

if (args[0] === '--help') {
  console.log(
    'Usage: fixture-cli <command>\n\nCommands:\n  echo <text>  Echo the text argument\n  upper <text>  Uppercase the input'
  );
  process.exit(0);
}

if (args[0] === 'echo') {
  console.log(args.slice(1).join(' '));
  process.exit(0);
}

if (args[0] === 'upper') {
  console.log(args.slice(1).join(' ').toUpperCase());
  process.exit(0);
}

console.error(`unknown command: ${args[0]}`);
process.exit(1);
