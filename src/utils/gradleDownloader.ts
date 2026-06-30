import { mkdir, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import * as https from "node:https";

const DEFAULT_GRADLE_VERSION = "8.8";

const GRADLEW_BAT_CONTENT = `@rem
@rem Copyright 2015 the original author or authors.
@rem
@rem Licensed under the Apache License, Version 2.0 (the "License");
@rem you may not use this file except in compliance with the License.
@rem You may obtain a copy of the License at
@rem
@rem      https://www.apache.org/licenses/LICENSE-2.0
@rem
@rem Unless required by applicable law or agreed to in writing, software
@rem distributed under the License is distributed on an "AS IS" BASIS,
@rem WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
@rem See the License for the specific language governing permissions and
@rem limitations under the License.
@rem

@if "%DEBUG%" == "" @echo off
@rem ##########################################################################
@rem
@rem  gradlew startup script for Windows
@rem
@rem ##########################################################################

@rem Set local scope for the variables with windows NT shell
if "%OS%"=="Windows_NT" setlocal

set DIRNAME=%~dp0
if "%DIRNAME%" == "" set DIRNAME=.
set APP_BASE_NAME=%~n0
set APP_HOME=%DIRNAME%

@rem Resolve any "." and ".." in APP_HOME to make it shorter.
for %%i in ("%APP_HOME%") do set APP_HOME=%%~fi

@rem Add default JVM options here. You can also use JAVA_OPTS and GRADLE_OPTS to pass JVM options to this script.
set DEFAULT_JVM_OPTS="-Xmx64m" "-Xms64m"

@rem Find java.exe
if defined JAVA_HOME goto findJavaFromJavaHome

set JAVA_EXE=java.exe
%JAVA_EXE% -version >NUL 2>&1
if "%ERRORLEVEL%" == "0" goto execute

echo.
echo ERROR: JAVA_HOME is not set and no 'java' command could be found in your PATH.
echo.
echo Please set the JAVA_HOME variable in your environment to match the
echo location of your Java installation.

goto fail

:findJavaFromJavaHome
set JAVA_HOME=%JAVA_HOME:"=%
set JAVA_EXE=%JAVA_HOME%/bin/java.exe

if exist "%JAVA_EXE%" goto execute

echo.
echo ERROR: JAVA_HOME is set to an invalid directory: %JAVA_HOME%
echo.
echo Please set the JAVA_HOME variable in your environment to match the
echo location of your Java installation.

goto fail

:execute
@rem Setup the command line

set CLASSPATH=%APP_HOME%\\gradle\\wrapper\\gradle-wrapper.jar


@rem Execute gradle
"%JAVA_EXE%" %DEFAULT_JVM_OPTS% %JAVA_OPTS% %GRADLE_OPTS% "-Dorg.gradle.appname=%APP_BASE_NAME%" -classpath "%CLASSPATH%" org.gradle.wrapper.GradleWrapperMain %*

:end
@rem Localize this to the end of the script but keep the associated values
if "%ERRORLEVEL%"=="0" goto mainEnd

:fail
rem Set variable GRADLE_EXIT_CONSOLE if you need the PATH or list of variables after execution
if not "" == "%GRADLE_EXIT_CONSOLE%" exit 1
exit /b 1

:mainEnd
if "%OS%"=="Windows_NT" endlocal
`;

const GRADLEW_SH_CONTENT = `#!/bin/sh

#
# Copyright © 2015-2021 the original author or authors.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#      https://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
#

##############################################################################
#
#   gradlew startup script for POSIX
#
##############################################################################

# Attempt to set APP_HOME

# Resolve links: $0 may be a link
PRG="$0"
# Need this for relative symlinks.
while [ -h "$PRG" ] ; do
    ls=\`ls -ld "$PRG"\`
    link=\`expr "$ls" : '.*-> \\(.*\\)$'\`
    if expr "$link" : '/.*' > /dev/null; then
        PRG="$link"
    else
        PRG=\`dirname "$PRG"\`/"$link"
    fi
done

SAVED="\`pwd\`"
cd "\`dirname \\"$PRG\\"\`" >/dev/null
APP_HOME="\`pwd\`"
cd "$SAVED" >/dev/null

APP_BASE_NAME=\`basename "$PRG"\`

# Add default JVM options here. You can also use JAVA_OPTS and GRADLE_OPTS to pass JVM options to this script.
DEFAULT_JVM_OPTS='"-Xmx64m" "-Xms64m"'

# Use the maximum available, or set MAX_FD != -1 to use that value.
MAX_FD="maximum"

warn () {
    echo "$*"
}

die () {
    echo
    echo "$*"
    echo
    exit 1
}

# OS specific support (must be 'true' or 'false').
cygwin=false
msys=false
darwin=false
nonstop=false
case "\`uname\`" in
  CYGWIN* ) cygwin=true ;;
  Darwin* ) darwin=true ;;
  MSYS* ) msys=true ;;
  NONSTOP* ) nonstop=true ;;
esac

CLASSPATH=$APP_HOME/gradle/wrapper/gradle-wrapper.jar

# Determine the Java command to use to start the JVM.
if [ -n "$JAVA_HOME" ] ; then
    if [ -x "$JAVA_HOME/jre/sh/java" ] ; then
        # IBM's JDK on AIX uses strange locations for the executables
        JAVACMD="$JAVA_HOME/jre/sh/java"
    else
        JAVACMD="$JAVA_HOME/bin/java"
    fi
    if [ ! -x "$JAVACMD" ] ; then
        die "ERROR: JAVA_HOME is set to an invalid directory: $JAVA_HOME

Please set the JAVA_HOME variable in your environment to match the
location of your Java installation."
    fi
else
    JAVACMD="java"
    which java >/dev/null 2>&1 || die "ERROR: JAVA_HOME is not set and no 'java' command could be found in your PATH.

Please set the JAVA_HOME variable in your environment to match the
location of your Java installation."
fi

# Increase the maximum file descriptors if we can.
if [ "$cygwin" = "false" -a "$msys" = "false" -a "$darwin" = "false" -a "$nonstop" = "false" ] ; then
    MAX_FD_LIMIT=\`ulimit -H -n\`
    if [ $? -eq 0 ] ; then
        if [ "$MAX_FD" = "maximum" -o "$MAX_FD" = "max" ] ; then
            MAX_FD="$MAX_FD_LIMIT"
        fi
        ulimit -n $MAX_FD
        if [ $? -ne 0 ] ; then
            warn "Could not set maximum file descriptor limit: $MAX_FD"
        fi
    fi
fi

# For Cygwin or MSYS, switch paths to Windows format before running java
if $cygwin ; then
    APP_HOME=\`cygpath --path --mixed "$APP_HOME"\`
    CLASSPATH=\`cygpath --path --mixed "$CLASSPATH"\`
fi

exec "$JAVACMD" \\
    -classpath "$CLASSPATH" \\
    org.gradle.wrapper.GradleWrapperMain \\
    "$@"
`;

export class GradleDownloader {
  public static async ensureWrapper(targetDir: string, gradleVersion = DEFAULT_GRADLE_VERSION): Promise<void> {
    const wrapperDir = join(targetDir, "gradle", "wrapper");
    const wrapperJarPath = join(wrapperDir, "gradle-wrapper.jar");
    const wrapperPropsPath = join(wrapperDir, "gradle-wrapper.properties");
    const gradlewPath = join(targetDir, "gradlew");
    const gradlewBatPath = join(targetDir, "gradlew.bat");

    // 1. Создать папки
    await mkdir(wrapperDir, { recursive: true });

    // 2. Записать gradle-wrapper.properties
    if (!existsSync(wrapperPropsPath)) {
      const propsContent = `distributionBase=GRADLE_USER_HOME
distributionPath=wrapper/dists
distributionUrl=https\\://services.gradle.org/distributions/gradle-${gradleVersion}-bin.zip
zipStoreBase=GRADLE_USER_HOME
zipStorePath=wrapper/dists
`;
      await writeFile(wrapperPropsPath, propsContent, "utf8");
    }

    // 3. Скачать gradle-wrapper.jar если его нет
    if (!existsSync(wrapperJarPath)) {
      const url = `https://raw.githubusercontent.com/gradle/gradle/v${gradleVersion}/gradle/wrapper/gradle-wrapper.jar`;
      await this.downloadFile(url, wrapperJarPath);
    }

    // 4. Записать gradlew и gradlew.bat если их нет
    if (!existsSync(gradlewPath)) {
      await writeFile(gradlewPath, GRADLEW_SH_CONTENT, "utf8");
      try {
        await chmod(gradlewPath, 0o755); // executable
      } catch {
        // ignore on platforms that don't support chmod easily (like Windows)
      }
    }

    if (!existsSync(gradlewBatPath)) {
      await writeFile(gradlewBatPath, GRADLEW_BAT_CONTENT, "utf8");
    }
  }

  private static downloadFile(url: string, destPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const request = https.get(url, (response) => {
        if (response.statusCode === 301 || response.statusCode === 302) {
          // Обработка редиректа (GitHub Raw URL часто перенаправляет)
          const redirectUrl = response.headers.location;
          if (redirectUrl) {
            this.downloadFile(redirectUrl, destPath).then(resolve).catch(reject);
            return;
          }
        }

        if (response.statusCode !== 200) {
          reject(new Error(`Failed to download gradle-wrapper.jar: Status code ${response.statusCode}`));
          return;
        }

        const fs = require("node:fs");
        const fileStream = fs.createWriteStream(destPath);
        response.pipe(fileStream);

        fileStream.on("finish", () => {
          fileStream.close();
          resolve();
        });

        fileStream.on("error", (err: Error) => {
          fs.unlink(destPath, () => {});
          reject(err);
        });
      });

      request.on("error", (err) => {
        reject(err);
      });
    });
  }
}
